"""在 QQ 里直接使用的命令。"""

import sqlite3

from minddock.items import list_items, search
from minddock.timeutil import friendly

LABEL = {
    "inbox": "处理中",
    "note": "笔记",
    "bookmark": "收藏",
    "todo": "待办",
    "reminder": "提醒",
    "file": "文件",
}

HELP = """MindDock 用法
· 直接发文字、链接、图片、文件，会自动归类
· 说"明天下午三点提醒我……"会设为提醒
· 加 #标签 打标签；加 #noai 不交给 AI 整理
· 密钥请以 #key 开头发送

命令
/s 关键词　搜索
/todo　未完成的待办
/help　查看本说明"""


def handle_command(conn: sqlite3.Connection, text: str, tz: str) -> str:
    command, _, arg = text.strip().partition(" ")
    command, arg = command.lower(), arg.strip()

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

    return "未知命令，发送 /help 查看用法"
