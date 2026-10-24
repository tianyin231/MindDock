"""提醒：到期检查、送达、重复排期，以及完成、延后、取消、改时间。

每个条目的提醒是 reminders 表里最新的一行。重复提醒送达后把 remind_at 前移到下一次，
延后（/later）只记在 snooze_at，不打乱原来的重复节奏。
"""

import calendar
import re
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from minddock.db import now_iso
from minddock.items import item_to_api, touch
from minddock.jobs import enqueue
from minddock.timeutil import friendly, parse_iso
from minddock.util import new_id

if TYPE_CHECKING:
    from minddock.notify import Notifier

REPEATS = ("none", "daily", "weekly", "monthly")
REPEAT_LABEL = {"daily": "每天", "weekly": "每周", "monthly": "每月"}
LATE_SECONDS = 180  # 比预定时间晚这么久才送达，消息里注明"延迟送达"
GIVE_UP_SECONDS = 3 * 3600  # 超过预定时间这么久仍发不出去：单次提醒标记失败，重复提醒跳过本次
MAX_SNOOZE_MINUTES = 30 * 1440
DURATION_RE = re.compile(r"^(\d{1,5})\s*(m|min|分|分钟|h|小时|d|天)?$", re.IGNORECASE)


class ReminderError(ValueError):
    pass


def _utc(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _add_months(moment: datetime, months: int) -> datetime:
    total = moment.month - 1 + months
    year, month = moment.year + total // 12, total % 12 + 1
    return moment.replace(
        year=year, month=month, day=min(moment.day, calendar.monthrange(year, month)[1])
    )


def next_occurrence(anchor_at: str, repeat: str, after: str, tz: str) -> str:
    """从锚点时间起按重复规则推算，返回晚于 after 的第一次；按本地时区计算，钟点保持不变。"""
    anchor = parse_iso(anchor_at).astimezone(ZoneInfo(tz))
    limit = parse_iso(after)
    step: Callable[[int], datetime]
    if repeat == "monthly":
        k = max(1, (limit.year - anchor.year) * 12 + limit.month - anchor.month - 1)

        def step(n: int) -> datetime:
            return _add_months(anchor, n)
    else:
        period = timedelta(days=1 if repeat == "daily" else 7)
        k = max(1, int((limit - anchor) / period))

        def step(n: int) -> datetime:
            return anchor + period * n

    while step(k) <= limit:
        k += 1
    return _utc(step(k))


def parse_minutes(token: str) -> int | None:
    """30 / 30m / 2h / 1d / 2小时 → 分钟数。"""
    match = DURATION_RE.match(token.strip())
    if not match:
        return None
    unit = (match.group(2) or "m").lower()
    minutes = int(match.group(1)) * (
        60 if unit in ("h", "小时") else 1440 if unit in ("d", "天") else 1
    )
    return minutes if 1 <= minutes <= MAX_SNOOZE_MINUTES else None


# ---- 查询 ----


def create(conn: sqlite3.Connection, item_id: str, remind_at: str, repeat: str) -> None:
    conn.execute(
        "INSERT INTO reminders (id, item_id, remind_at, anchor_at, repeat, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (new_id(), item_id, remind_at, remind_at, repeat, now_iso()),
    )


def current(conn: sqlite3.Connection, item_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM reminders WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", (item_id,)
    ).fetchone()


def last_sent_item(conn: sqlite3.Connection) -> str | None:
    """最近一次送达的提醒所属条目，/done 和 /later 不带编号时作用于它。"""
    row = conn.execute(
        "SELECT r.item_id FROM reminders r JOIN items i ON i.id = r.item_id "
        "WHERE r.sent_at IS NOT NULL AND i.status = 'active' ORDER BY r.sent_at DESC LIMIT 1"
    ).fetchone()
    return row[0] if row else None


def upcoming(conn: sqlite3.Connection, limit: int = 10) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT r.item_id, MIN(r.remind_at, COALESCE(r.snooze_at, r.remind_at)) AS next_at "
        "FROM reminders r JOIN items i ON i.id = r.item_id "
        "WHERE r.status = 'scheduled' AND i.status = 'active' ORDER BY next_at LIMIT ?",
        (limit,),
    ).fetchall()
    return [i for i in (item_to_api(conn, r["item_id"]) for r in rows) if i]


def schedule_due(conn: sqlite3.Connection) -> int:
    """把到点的提醒放进任务队列；同一提醒只会有一个活动任务。"""
    now = now_iso()
    rows = conn.execute(
        "SELECT r.id FROM reminders r JOIN items i ON i.id = r.item_id "
        "WHERE r.status = 'scheduled' AND i.status = 'active' "
        "AND (r.remind_at <= ? OR r.snooze_at <= ?)",
        (now, now),
    ).fetchall()
    for row in rows:
        enqueue(conn, "remind", row[0])
    return len(rows)


def seconds_until_next(conn: sqlite3.Connection, cap: float = 30) -> float:
    row = conn.execute(
        "SELECT MIN(MIN(r.remind_at, COALESCE(r.snooze_at, r.remind_at))) "
        "FROM reminders r JOIN items i ON i.id = r.item_id "
        "WHERE r.status = 'scheduled' AND i.status = 'active'"
    ).fetchone()
    if not row or not row[0]:
        return cap
    wait = (parse_iso(row[0]) - datetime.now(UTC)).total_seconds()
    return min(cap, max(1.0, wait))


# ---- 送达 ----


def render(item: dict[str, Any], due_at: str, next_at: str | None, tz: str) -> str:
    lines = [f"⏰ 提醒：{item['title']}（#{item['code']}）"]
    if due_at < now_iso(-LATE_SECONDS):
        lines.append(f"（延迟送达，原定 {friendly(due_at, tz)}）")
    if next_at:
        lines.append(f"下次：{friendly(next_at, tz)}")
    lines.append("回复 /done 完成，/later 30m 稍后再提醒")
    return "\n".join(lines)


async def deliver(
    conn: sqlite3.Connection, notifier: "Notifier", reminder_id: str, tz: str, public_url: str = ""
) -> None:
    row = conn.execute(
        "SELECT r.* FROM reminders r JOIN items i ON i.id = r.item_id "
        "WHERE r.id = ? AND i.status = 'active'",
        (reminder_id,),
    ).fetchone()
    if row is None or row["status"] != "scheduled":
        return
    now = now_iso()
    due = [t for t in (row["remind_at"], row["snooze_at"]) if t and t <= now]
    item = item_to_api(conn, row["item_id"])
    if not due or item is None:
        return
    due_at, repeating = min(due), row["repeat"] != "none"

    # 重复提醒：本次到点后排到下一次；只是延后的那次到点则保持原来的节奏
    next_at = None
    if repeating:
        next_at = (
            next_occurrence(row["anchor_at"], row["repeat"], now, tz)
            if row["remind_at"] <= now
            else row["remind_at"]
        )

    text = render(item, due_at, next_at, tz)
    body = text + (
        f"\n\n在面板中查看：{public_url.rstrip('/')}/reminders?item={item['id']}"
        if public_url
        else ""
    )
    result = await notifier.send(text, email_subject=f"⏰ 提醒：{item['title']}", email_body=body)

    if result.channel is None:
        error = "；".join(result.errors)[:500]
        if due_at < now_iso(-GIVE_UP_SECONDS):
            if repeating:
                conn.execute(
                    "UPDATE reminders SET remind_at = ?, snooze_at = NULL, last_error = ? WHERE id = ?",
                    (next_at, error, reminder_id),
                )
            else:
                conn.execute(
                    "UPDATE reminders SET status = 'failed', last_error = ? WHERE id = ?",
                    (error, reminder_id),
                )
            touch(conn, row["item_id"])
            return
        conn.execute("UPDATE reminders SET last_error = ? WHERE id = ?", (error, reminder_id))
        touch(conn, row["item_id"])
        raise RuntimeError(f"提醒没有送达，稍后重试：{error}")

    if repeating:
        conn.execute(
            "UPDATE reminders SET remind_at = ?, snooze_at = NULL, channel = ?, sent_at = ?, "
            "done_at = NULL, last_error = NULL WHERE id = ?",
            (next_at, result.channel, now, reminder_id),
        )
    else:
        conn.execute(
            "UPDATE reminders SET status = 'sent', snooze_at = NULL, channel = ?, sent_at = ?, "
            "last_error = NULL WHERE id = ?",
            (result.channel, now, reminder_id),
        )
    touch(conn, row["item_id"])


# ---- 完成、延后、取消、改时间（QQ 命令与面板共用） ----


def _require(conn: sqlite3.Connection, item_id: str) -> sqlite3.Row:
    row = current(conn, item_id)
    if row is None or row["status"] == "cancelled":
        raise ReminderError("这条没有进行中的提醒")
    return row


def mark_done(conn: sqlite3.Connection, item_id: str) -> dict[str, Any]:
    """单次提醒标记完成；重复提醒只记下本次已完成，之后照常提醒。"""
    row = _require(conn, item_id)
    status = "done" if row["repeat"] == "none" else row["status"]
    conn.execute(
        "UPDATE reminders SET status = ?, done_at = ?, snooze_at = NULL WHERE id = ?",
        (status, now_iso(), row["id"]),
    )
    return touch(conn, item_id)


def snooze(conn: sqlite3.Connection, item_id: str, minutes: int) -> dict[str, Any]:
    if not 1 <= minutes <= MAX_SNOOZE_MINUTES:
        raise ReminderError("延后时间需要在 1 分钟到 30 天之间")
    row = _require(conn, item_id)
    at = now_iso(minutes * 60)
    if row["repeat"] == "none":
        conn.execute(
            "UPDATE reminders SET remind_at = ?, status = 'scheduled', done_at = NULL, "
            "last_error = NULL WHERE id = ?",
            (at, row["id"]),
        )
    else:
        conn.execute(
            "UPDATE reminders SET snooze_at = ?, done_at = NULL WHERE id = ?", (at, row["id"])
        )
    return touch(conn, item_id)


def cancel(conn: sqlite3.Connection, item_id: str) -> dict[str, Any]:
    row = _require(conn, item_id)
    conn.execute(
        "UPDATE reminders SET status = 'cancelled', snooze_at = NULL WHERE id = ?", (row["id"],)
    )
    return touch(conn, item_id)


def reschedule(
    conn: sqlite3.Connection, item_id: str, remind_at: str, repeat: str
) -> dict[str, Any]:
    if repeat not in REPEATS:
        raise ReminderError("重复规则不正确")
    if remind_at < now_iso(-60):
        raise ReminderError("提醒时间已经过去了")
    row = current(conn, item_id)
    if row is None:
        create(conn, item_id, remind_at, repeat)
    else:
        conn.execute(
            "UPDATE reminders SET remind_at = ?, anchor_at = ?, repeat = ?, snooze_at = NULL, "
            "status = 'scheduled', done_at = NULL, last_error = NULL WHERE id = ?",
            (remind_at, remind_at, repeat, row["id"]),
        )
    return touch(conn, item_id)
