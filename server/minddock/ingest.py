"""把一条收到的消息写进数据库：条目、修订、附件、全文索引、后台任务、实时事件。"""

import json
import re
import sqlite3
from dataclasses import dataclass, field

from minddock.db import now_iso
from minddock.items import ATTACHMENT_LABEL, URL_RE, item_to_api, reindex
from minddock.jobs import enqueue
from minddock.util import emit, new_code, new_id

TAG_RE = re.compile(r"(?:^|\s)#([^\s#]{1,20})")
NOAI_RE = re.compile(r"(?i)(?:^|\s)#noai(?:\s|$)")
RESERVED_TAGS = {"noai", "key"}


@dataclass
class IncomingAttachment:
    url: str
    filename: str = ""
    content_type: str = ""
    size: int | None = None
    width: int | None = None
    height: int | None = None


@dataclass
class Incoming:
    msg_id: str | None  # 面板提交的内容没有 QQ 消息 ID
    openid: str
    content: str
    attachments: list[IncomingAttachment] = field(default_factory=list)


@dataclass
class IngestResult:
    item_id: str
    code: str
    summary: str
    organizing: bool


def attachment_kind(content_type: str, filename: str) -> str:
    ct, name = content_type.lower(), filename.lower()
    if ct.startswith("image"):
        return "image"
    if ct.startswith("video"):
        return "video"
    if ct.startswith("audio") or ct == "voice" or name.endswith((".silk", ".amr", ".mp3", ".m4a")):
        return "audio"
    return "file"


def ingest(conn: sqlite3.Connection, msg: Incoming, source: str = "qq") -> IngestResult | None:
    """返回 None 表示这条消息已处理过（QQ 重连后可能重复投递）。"""
    if (
        msg.msg_id
        and conn.execute("SELECT 1 FROM items WHERE source_msg_id = ?", (msg.msg_id,)).fetchone()
    ):
        return None

    text = msg.content.strip()
    tags = [t for t in TAG_RE.findall(text) if t.lower() not in RESERVED_TAGS]
    no_ai = bool(NOAI_RE.search(text))
    kinds = [attachment_kind(a.content_type, a.filename) for a in msg.attachments]
    has_url = bool(URL_RE.search(text))
    if kinds and text:
        kind = "mixed"
    elif kinds:
        kind = "media"
    elif has_url:
        kind = "link"
    else:
        kind = "text"

    item_id, code, now = new_id(), new_code(conn), now_iso()
    conn.execute("BEGIN")
    try:
        conn.execute(
            "INSERT INTO items (id, short_code, source, source_msg_id, kind, text, user_tags, no_ai, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                item_id,
                code,
                source,
                msg.msg_id,
                kind,
                text,
                json.dumps(tags, ensure_ascii=False),
                int(no_ai),
                now,
                now,
            ),
        )
        conn.execute(
            "INSERT INTO item_revisions (item_id, text, created_at) VALUES (?, ?, ?)",
            (item_id, text, now),
        )
        for att, att_kind in zip(msg.attachments, kinds, strict=True):
            file_id = new_id()
            meta = {k: v for k, v in (("width", att.width), ("height", att.height)) if v}
            conn.execute(
                "INSERT INTO files (id, item_id, size, mime, original_name, kind, meta, source_url, "
                "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    file_id,
                    item_id,
                    att.size,
                    att.content_type if "/" in att.content_type else None,
                    att.filename or None,
                    att_kind,
                    json.dumps(meta),
                    att.url,
                    now,
                ),
            )
            enqueue(conn, "download", file_id)
        if not no_ai:
            enqueue(conn, "organize", item_id)
        reindex(conn, item_id)
        emit(conn, "item.received", {"item": item_to_api(conn, item_id)})
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    parts = []
    if text:
        parts.append("链接" if has_url else "文字")
    for label in ("image", "video", "audio", "file"):
        n = kinds.count(label)
        if n:
            parts.append(f"{ATTACHMENT_LABEL[label]} {n}" if n > 1 else ATTACHMENT_LABEL[label])
    return IngestResult(item_id, code, "、".join(parts) or "空消息", organizing=not no_ai)
