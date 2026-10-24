"""在 QQ 里直接使用的命令。"""

import re
import sqlite3

from minddock import reminders
from minddock.items import list_items, search, set_todo_done
from minddock.timeutil import friendly

LABEL = {
    "inbox": "处理中",
    "note": "笔记",
    "bookmark": "收藏",
    "todo": "待办",
    "reminder": "提醒",
    "file": "文件",
}
CODE_RE = re.compile(r"^#?([0-9A-Za-z]{4,5})$")
DEFAULT_SNOOZE = 30

HELP = """MindDock 用法
· 直接发文字、链接、图片、文件，会自动归类
· 说"明天下午三点提醒我……"会设为提醒
· 加 #标签 打标签；加 #noai 不交给 AI 整理
· 密钥：#key 名称，换行后写内容（可附图片），加密存入密钥库

命令
/s 关键词　搜索
/todo　未完成的待办
/提醒　接下来的提醒
/done #编号　完成待办或提醒（不写编号指刚收到的提醒）
/later 30m　刚收到的提醒稍后再提醒（也可写 2h、1d，或 /later #编号 2h）
/help　查看本说明"""


def _target(conn: sqlite3.Connection, tokens: list[str]) -> tuple[sqlite3.Row | None, list[str]]:
    """从参数里取出 #编号；没有编号时指向最近一次送达的提醒。返回条目和剩余参数。"""
    rest, code = [], None
    for token in tokens:
        match = CODE_RE.match(token)
        # 不带 # 时，能当作时长的（如 120、120m）按时长理解
        if (
            code is None
            and match
            and (token.startswith("#") or reminders.parse_minutes(token) is None)
        ):
            code = match.group(1).upper()
        else:
            rest.append(token)
    if code:
        row = conn.execute(
            "SELECT id, short_code, partition FROM items WHERE short_code = ? AND status = 'active'",
            (code,),
        ).fetchone()
    else:
        item_id = reminders.last_sent_item(conn)
        row = (
            conn.execute(
                "SELECT id, short_code, partition FROM items WHERE id = ?", (item_id,)
            ).fetchone()
            if item_id
            else None
        )
    return row, rest


def _done(conn: sqlite3.Connection, args: list[str], tz: str) -> str:
    row, _ = _target(conn, args)
    if row is None:
        return "没有找到要完成的条目，请写上编号，例如 /done #A3F9"
    code = row["short_code"]
    if row["partition"] == "todo" and set_todo_done(conn, row["id"], True):
        return f"✅ #{code} 待办已完成"
    try:
        item = reminders.mark_done(conn, row["id"])
    except reminders.ReminderError:
        return f"#{code} 不是待办或进行中的提醒"
    reminder = item["reminder"]
    if reminder["repeat"] != "none":
        return f"✅ #{code} 本次已完成，下次：{friendly(reminder['remindAt'], tz)}"
    return f"✅ #{code} 提醒已完成"


def _later(conn: sqlite3.Connection, args: list[str], tz: str) -> str:
    row, rest = _target(conn, args)
    if row is None:
        return "没有找到要延后的提醒，请写上编号，例如 /later #A3F9 30m"
    minutes = reminders.parse_minutes(rest[0]) if rest else DEFAULT_SNOOZE
    if minutes is None:
        return "时长写法：30m、2h、1d（最长 30 天）"
    try:
        item = reminders.snooze(conn, row["id"], minutes)
    except reminders.ReminderError as exc:
        return f"#{row['short_code']} {exc}"
    return f"⏰ #{row['short_code']} 将在 {friendly(item['reminder']['remindAt'], tz)} 再提醒你"


def _upcoming(conn: sqlite3.Connection, tz: str) -> str:
    items = reminders.upcoming(conn)
    if not items:
        return "⏰ 没有待发送的提醒"
    lines = ["⏰ 接下来的提醒："]
    for i in items:
        r = i["reminder"]
        repeat = f"，{reminders.REPEAT_LABEL[r['repeat']]}" if r["repeat"] != "none" else ""
        lines.append(f"#{i['code']} {i['title']}（{friendly(r['remindAt'], tz)}{repeat}）")
    return "\n".join(lines)


def handle_command(conn: sqlite3.Connection, text: str, tz: str) -> str:
    command, *args = text.strip().split()
    command = command.lower()
    arg = " ".join(args)

    if command in ("/help", "/h", "/帮助"):
        return HELP

    if command in ("/s", "/search", "/搜索"):
        if not arg:
            return "用法：/s 关键词"
        results = search(conn, arg, limit=5)
        if not results:
            return f"🔍 没有找到「{arg}」"
        lines = [f"🔍「{arg}」找到 {len(results)} 条："]
        lines += [f"#{i['code']} {LABEL[i['partition']]} · {i['title']}" for i in results]
        return "\n".join(lines)

    if command in ("/todo", "/待办"):
        todos = [i for i in list_items(conn, "todo") if not i["todo"]["doneAt"]][:10]
        if not todos:
            return "✅ 没有未完成的待办"
        lines = ["📋 未完成的待办："]
        for i in todos:
            due = i["todo"]["dueAt"]
            lines.append(f"#{i['code']} {i['title']}" + (f"（{friendly(due, tz)}）" if due else ""))
        return "\n".join(lines)

    if command in ("/提醒", "/r", "/reminders"):
        return _upcoming(conn, tz)

    if command in ("/done", "/完成"):
        return _done(conn, args, tz)

    if command in ("/later", "/稍后"):
        return _later(conn, args, tz)

    return "未知命令，发送 /help 查看用法"
