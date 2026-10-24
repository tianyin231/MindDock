"""到点提醒：重复排期、送达渠道与兜底、QQ 命令、被动回复额度、数据迁移。"""

import asyncio

import pytest

from minddock import notify, reminders
from minddock.bot import OWNER_KEY
from minddock.commands import handle_command
from minddock.db import _migrations, connect, migrate, now_iso
from minddock.ingest import Incoming, ingest
from minddock.items import item_to_api, move
from minddock.notify import Notifier
from minddock.qq.api import QQError
from minddock.qq.replies import MAX_REPLIES, next_reply_seq, record_inbound
from minddock.security import Cipher
from minddock.settings_store import SettingsStore
from minddock.util import kv_set

TZ = "Asia/Shanghai"


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    migrate(c)
    kv_set(c, OWNER_KEY, {"openid": "me", "bound_at": now_iso()})
    return c


class FakeQQ:
    def __init__(self, fail_reply=False, fail_active=False):
        self.sent: list[tuple[str, str | None, int]] = []
        self.fail_reply, self.fail_active = fail_reply, fail_active

    async def send_c2c(self, openid, content, msg_id=None, msg_seq=1):
        if (msg_id and self.fail_reply) or (not msg_id and self.fail_active):
            raise QQError("发送消息失败：主动消息额度不足（22009）")
        self.sent.append((content, msg_id, msg_seq))
        return {}


def make_notifier(conn, qq) -> Notifier:
    n = Notifier(conn, SettingsStore(conn, Cipher(b"k" * 32)), None)
    n.qq = lambda: qq
    return n


def reminder_item(conn, text="交周报", remind_at=None, repeat="none", msg_id="m1") -> str:
    item_id = ingest(conn, Incoming(msg_id=msg_id, openid="me", content=text)).item_id
    conn.execute("UPDATE items SET partition = 'reminder' WHERE id = ?", (item_id,))
    reminders.create(conn, item_id, remind_at or now_iso(-5), repeat)
    return item_id


def deliver(conn, notifier, item_id):
    rid = reminders.current(conn, item_id)["id"]
    asyncio.run(reminders.deliver(conn, notifier, rid, TZ, "https://md.example"))
    return reminders.current(conn, item_id)


def code_of(conn, item_id) -> str:
    return item_to_api(conn, item_id)["code"]


# ---- 时间计算 ----


def test_next_occurrence_keeps_clock_and_month_end():
    anchor = "2026-10-20T00:00:00Z"  # 北京时间 08:00
    assert reminders.next_occurrence(anchor, "daily", "2026-10-24T05:00:00Z", TZ) == (
        "2026-10-25T00:00:00Z"
    )
    # 恰好等于本次时间时取下一次
    assert reminders.next_occurrence(anchor, "weekly", "2026-10-27T00:00:00Z", TZ) == (
        "2026-11-03T00:00:00Z"
    )
    month_end = "2026-01-31T01:00:00Z"
    assert reminders.next_occurrence(month_end, "monthly", "2026-02-01T00:00:00Z", TZ) == (
        "2026-02-28T01:00:00Z"
    )
    # 2 月过后回到 31 日，不会一直停在 28 日
    assert reminders.next_occurrence(month_end, "monthly", "2026-03-01T00:00:00Z", TZ) == (
        "2026-03-31T01:00:00Z"
    )


@pytest.mark.parametrize(
    ("token", "minutes"),
    [
        ("30", 30),
        ("30m", 30),
        ("2h", 120),
        ("1d", 1440),
        ("2小时", 120),
        ("abc", None),
        ("0", None),
    ],
)
def test_parse_minutes(token, minutes):
    assert reminders.parse_minutes(token) == minutes


# ---- 被动回复额度 ----


def test_reply_seq_is_shared_and_limited(conn):
    record_inbound(conn, "x")
    assert [next_reply_seq(conn, "x") for _ in range(MAX_REPLIES + 1)] == [1, 2, 3, 4, 5, None]
    record_inbound(conn, "old")
    conn.execute("UPDATE qq_inbound SET received_at = ? WHERE msg_id = 'old'", (now_iso(-3600),))
    assert next_reply_seq(conn, "old") is None
    assert next_reply_seq(conn, "unknown") is None


# ---- 送达 ----


def test_reminder_replies_to_recent_message_first(conn):
    item_id = reminder_item(conn)
    record_inbound(conn, "recent")
    qq = FakeQQ()
    row = deliver(conn, make_notifier(conn, qq), item_id)
    content, msg_id, seq = qq.sent[0]
    assert (msg_id, seq) == ("recent", 1)
    assert content.startswith("⏰ 提醒：交周报（#") and "/done" in content
    assert (row["status"], row["channel"]) == ("sent", "qq") and row["sent_at"]
    assert item_to_api(conn, item_id)["reminder"]["sentAt"] == row["sent_at"]


def test_repeating_reminder_uses_active_message_and_moves_on(conn):
    item_id = reminder_item(conn, "喝水", repeat="daily")
    qq = FakeQQ()
    row = deliver(conn, make_notifier(conn, qq), item_id)
    assert qq.sent[0][1] is None  # 没有可回复的消息，发主动消息
    assert "下次：" in qq.sent[0][0]
    assert row["status"] == "scheduled" and row["remind_at"] > now_iso() and row["sent_at"]


def test_late_delivery_is_marked(conn):
    item_id = reminder_item(conn, remind_at=now_iso(-600))
    qq = FakeQQ()
    deliver(conn, make_notifier(conn, qq), item_id)
    assert "延迟送达" in qq.sent[0][0]


def test_email_fallback_then_retry_then_give_up(conn, monkeypatch):
    mails = []
    monkeypatch.setattr(notify, "send_email", lambda cfg, subject, body: mails.append(body))
    qq = FakeQQ(fail_reply=True, fail_active=True)
    notifier = make_notifier(conn, qq)

    # 没配邮件：记录错误并抛出，交给任务队列重试
    item_id = reminder_item(conn)
    with pytest.raises(RuntimeError, match="稍后重试"):
        deliver(conn, notifier, item_id)
    row = reminders.current(conn, item_id)
    assert row["status"] == "scheduled" and "额度不足" in row["last_error"]

    # 超过放弃时间仍发不出去：单次提醒标记失败
    conn.execute("UPDATE reminders SET remind_at = ? WHERE id = ?", (now_iso(-4 * 3600), row["id"]))
    assert deliver(conn, notifier, item_id)["status"] == "failed"

    # 配了邮件：QQ 发不出去时改发邮件，正文带面板链接
    notifier.store.update(
        "notify",
        {
            "smtp_host": "smtp.example.com",
            "smtp_user": "a@example.com",
            "smtp_password": "p",
            "to_email": "me@qq.com",
        },
    )
    other = reminder_item(conn, "交房租", msg_id="m2")
    row = deliver(conn, notifier, other)
    assert (row["status"], row["channel"]) == ("sent", "email")
    assert f"https://md.example/reminders?item={other}" in mails[0]


def test_due_reminders_are_queued_once(conn):
    reminder_item(conn)
    reminder_item(conn, "以后的事", remind_at=now_iso(3600), msg_id="m2")
    assert reminders.schedule_due(conn) == 1
    reminders.schedule_due(conn)
    assert conn.execute("SELECT COUNT(*) FROM jobs WHERE type = 'remind'").fetchone()[0] == 1
    assert 1 <= reminders.seconds_until_next(conn) <= 30


def test_moving_out_of_reminders_cancels(conn):
    item_id = reminder_item(conn, remind_at=now_iso(3600))
    move(conn, item_id, "note")
    assert reminders.current(conn, item_id)["status"] == "cancelled"


# ---- QQ 命令 ----


def test_done_and_later_default_to_last_sent_reminder(conn):
    item_id = reminder_item(conn)
    deliver(conn, make_notifier(conn, FakeQQ()), item_id)

    assert "再提醒你" in handle_command(conn, "/later 2h", TZ)
    row = reminders.current(conn, item_id)
    assert row["status"] == "scheduled" and now_iso(7100) < row["remind_at"] < now_iso(7300)

    assert handle_command(conn, "/later 120", TZ).endswith("再提醒你")  # 纯数字按分钟理解
    assert "已完成" in handle_command(conn, "/done", TZ)
    assert reminders.current(conn, item_id)["status"] == "done"
    assert handle_command(conn, "/提醒", TZ) == "⏰ 没有待发送的提醒"


def test_repeating_reminder_snooze_keeps_rhythm(conn):
    item_id = reminder_item(conn, "喝水", repeat="daily")
    deliver(conn, make_notifier(conn, FakeQQ()), item_id)
    code = code_of(conn, item_id)
    series = reminders.current(conn, item_id)["remind_at"]

    handle_command(conn, f"/later #{code} 10m", TZ)
    row = reminders.current(conn, item_id)
    assert row["remind_at"] == series and row["snooze_at"] < series
    assert item_to_api(conn, item_id)["reminder"]["remindAt"] == row["snooze_at"]
    assert f"#{code}" in handle_command(conn, "/提醒", TZ)

    assert "本次已完成" in handle_command(conn, f"/done {code}", TZ)
    row = reminders.current(conn, item_id)
    assert row["status"] == "scheduled" and row["snooze_at"] is None and row["done_at"]


def test_done_completes_todo_by_code(conn):
    item_id = ingest(conn, Incoming(msg_id="t1", openid="me", content="买猫粮")).item_id
    move(conn, item_id, "todo")
    assert "待办已完成" in handle_command(conn, f"/done #{code_of(conn, item_id)}", TZ)
    assert item_to_api(conn, item_id)["todo"]["doneAt"]
    assert "没有找到" in handle_command(conn, "/done #ZZZZ", TZ)
    assert "时长写法" in handle_command(conn, f"/later #{code_of(conn, item_id)} soon", TZ)


# ---- 数据迁移 ----


def test_migration_keeps_reminders_and_reply_counts(tmp_path):
    c = connect(tmp_path / "old.db")
    for number, path in _migrations()[:3]:
        c.executescript(
            f"BEGIN;\n{path.read_text(encoding='utf-8')}\nPRAGMA user_version = {number};\nCOMMIT;"
        )
    now = now_iso()
    c.execute(
        "INSERT INTO items (id, short_code, source, source_msg_id, kind, reply_seq, created_at, "
        "updated_at) VALUES ('i1', 'A3F9', 'qq', 'm1', 'text', 2, ?, ?)",
        (now, now),
    )
    c.execute(
        "INSERT INTO reminders (id, item_id, remind_at, repeat, created_at) "
        "VALUES ('r1', 'i1', '2026-10-25T00:00:00Z', 'daily', ?)",
        (now,),
    )
    migrate(c)
    row = c.execute("SELECT * FROM reminders WHERE id = 'r1'").fetchone()
    assert row["anchor_at"] == row["remind_at"] == "2026-10-25T00:00:00Z"
    assert c.execute("SELECT reply_seq FROM qq_inbound WHERE msg_id = 'm1'").fetchone()[0] == 2
    assert "reply_seq" not in [r[1] for r in c.execute("PRAGMA table_info(items)")]
