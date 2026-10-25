"""通用小工具：ID、短编号、键值设置、事件。"""

import json
import os
import secrets
import sqlite3
import time
from typing import Any

from minddock.db import now_iso

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def new_id() -> str:
    """ULID：48 位毫秒时间戳 + 80 位随机数，按时间有序。"""
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    chars = []
    for _ in range(26):
        chars.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def new_code(conn: sqlite3.Connection) -> str:
    """回执里的短编号，如 A3F9，条目和密钥共用一套；撞号时重试，太挤了就加长一位。"""
    for attempt in range(20):
        code = "".join(secrets.choice(_CODE_CHARS) for _ in range(4 if attempt < 10 else 5))
        taken = conn.execute(
            "SELECT 1 FROM items WHERE short_code = ? UNION ALL "
            "SELECT 1 FROM secrets WHERE short_code = ?",
            (code, code),
        ).fetchone()
        if not taken:
            return code
    raise RuntimeError("无法生成不重复的编号")


def audit(conn: sqlite3.Connection, action: str, target: str | None, ip: str | None) -> None:
    conn.execute(
        "INSERT INTO audit_log (at, action, target, ip) VALUES (?, ?, ?, ?)",
        (now_iso(), action, target, ip),
    )


def kv_get(conn: sqlite3.Connection, key: str, default: Any = None) -> Any:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def kv_set(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def kv_delete(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM settings WHERE key = ?", (key,))


def emit(conn: sqlite3.Connection, event_type: str, payload: dict[str, Any]) -> None:
    """写入进程间事件，面板通过 SSE 推给浏览器。"""
    conn.execute(
        "INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)",
        (event_type, json.dumps(payload, ensure_ascii=False), now_iso()),
    )


def https_url(url: str) -> str | None:
    """把 QQ 给的附件地址规范成 https；协议相对地址和 http 都改用 https，其他协议返回 None。"""
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    if url[:7].lower() == "http://":
        return "https://" + url[7:]
    if url[:8].lower() == "https://":
        return url
    return None


def require_https(url: str) -> None:
    """下载附件前的最后一道检查：不是 https 就拒绝，避免内容（包括密钥附件）明文经过公网。"""
    if not url.lower().startswith("https://"):
        raise RuntimeError("附件地址不是 HTTPS，为避免明文传输已拒绝下载")


def prune_events(conn: sqlite3.Connection, keep_seconds: int = 86400) -> None:
    conn.execute("DELETE FROM events WHERE created_at < ?", (now_iso(-keep_seconds),))
