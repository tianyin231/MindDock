"""被动回复额度：收到消息后 60 分钟内可回复，同一消息最多 5 次，msg_seq 不能重复。

bot（回执、命令结果）和 worker（整理确认、到点提醒）会回复同一条消息，所以 msg_seq 统一在数据库里分配。
"""

import sqlite3

from minddock.db import now_iso

REPLY_WINDOW = 55 * 60  # 平台限制 60 分钟，留出余量
MAX_REPLIES = 5


def record_inbound(conn: sqlite3.Connection, msg_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO qq_inbound (msg_id, received_at) VALUES (?, ?)", (msg_id, now_iso())
    )


def next_reply_seq(conn: sqlite3.Connection, msg_id: str) -> int | None:
    """占用该消息的下一个 msg_seq；消息未记录、已超时或次数用完时返回 None。"""
    rows = conn.execute(
        "UPDATE qq_inbound SET reply_seq = reply_seq + 1 "
        "WHERE msg_id = ? AND reply_seq < ? AND received_at > ? RETURNING reply_seq",
        (msg_id, MAX_REPLIES, now_iso(-REPLY_WINDOW)),
    ).fetchall()
    return rows[0][0] if rows else None


def latest_inbound(conn: sqlite3.Connection) -> str | None:
    """主人最近发来、还能回复的消息。"""
    row = conn.execute(
        "SELECT msg_id FROM qq_inbound WHERE received_at > ? AND reply_seq < ? "
        "ORDER BY received_at DESC LIMIT 1",
        (now_iso(-REPLY_WINDOW), MAX_REPLIES),
    ).fetchone()
    return row[0] if row else None


def prune_inbound(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM qq_inbound WHERE received_at < ?", (now_iso(-86400),))
