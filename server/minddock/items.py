"""条目的查询、序列化与修改。返回的字典结构与前端 web/src/api/types.ts 中的 Item 一致。"""

import hashlib
import json
import re
import sqlite3
from typing import Any
from urllib.parse import urlparse

from minddock.db import now_iso
from minddock.util import emit, new_code, new_id

PARTITIONS = ("inbox", "note", "bookmark", "todo", "reminder", "file")
MOVABLE = ("note", "bookmark", "todo", "reminder", "file")
URL_RE = re.compile(r"https?://[^\s<>\"'，。！？、）)】]+")
ATTACHMENT_LABEL = {"image": "图片", "video": "视频", "audio": "语音", "file": "文件"}


def _hue(value: str) -> int:
    return int(hashlib.md5(value.encode()).hexdigest()[:4], 16) % 360


def _first_line(text: str, limit: int = 40) -> str:
    line = text.strip().splitlines()[0] if text.strip() else ""
    return line if len(line) <= limit else line[: limit - 1] + "…"


def _processing(conn: sqlite3.Connection, item: sqlite3.Row) -> dict[str, Any] | None:
    if item["partition"] != "inbox":
        return None
    job = conn.execute(
        "SELECT status, last_error FROM jobs WHERE type = 'organize' AND ref_id = ? "
        "ORDER BY id DESC LIMIT 1",
        (item["id"],),
    ).fetchone()
    if job is None:
        hint = "标记了 #noai，请手动归类" if item["no_ai"] else "等待归类"
        return {"stage": "failed", "error": hint}
    if job["status"] in ("queued", "running"):
        return {"stage": "organizing"}
    if job["status"] == "failed":
        return {"stage": "failed", "error": f"{job['last_error']}（稍后自动重试）"}
    if job["status"] == "dead":
        return {"stage": "failed", "error": f"{job['last_error']}（已停止自动重试）"}
    return None


def item_to_api(conn: sqlite3.Connection, item_id: str) -> dict[str, Any] | None:
    item = conn.execute(
        "SELECT * FROM items WHERE id = ? AND status = 'active'", (item_id,)
    ).fetchone()
    if item is None:
        return None
    derived = conn.execute("SELECT * FROM derived WHERE item_id = ?", (item_id,)).fetchone()
    files = conn.execute(
        "SELECT * FROM files WHERE item_id = ? ORDER BY created_at, id", (item_id,)
    ).fetchall()
    link = conn.execute(
        "SELECT * FROM links WHERE item_id = ? ORDER BY id LIMIT 1", (item_id,)
    ).fetchone()
    todo = conn.execute("SELECT * FROM todos WHERE item_id = ?", (item_id,)).fetchone()
    reminder = conn.execute(
        "SELECT * FROM reminders WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", (item_id,)
    ).fetchone()

    attachments = []
    for f in files:
        meta = json.loads(f["meta"] or "{}")
        local = bool(f["local_path"])
        upload_error = None
        if f["upload_status"] == "failed":
            job = conn.execute(
                "SELECT status, last_error FROM jobs WHERE type = 'upload' AND ref_id = ? "
                "ORDER BY id DESC LIMIT 1",
                (f["id"],),
            ).fetchone()
            if job and job["last_error"]:
                retrying = "稍后自动重试" if job["status"] == "failed" else "已停止自动重试"
                upload_error = f"{job['last_error']}（{retrying}）"
        attachments.append(
            {
                "id": f["id"],
                "kind": f["kind"],
                "name": f["original_name"] or ATTACHMENT_LABEL[f["kind"]],
                "size": f["size"] or 0,
                "mime": f["mime"] or "",
                "uploadStatus": f["upload_status"],
                "uploadError": upload_error,
                "hue": _hue(f["id"]),
                "durationSec": meta.get("duration"),
                "previewUrl": f"/api/files/{f['id']}/raw"
                if local and f["kind"] == "image"
                else None,
                "downloadUrl": f"/api/files/{f['id']}/raw?download=1" if local else None,
            }
        )

    title = (
        item["user_title"] or (derived["title"] if derived else None) or _first_line(item["text"])
    )
    if not title and attachments:
        title = f"[{ATTACHMENT_LABEL[attachments[0]['kind']]}] {attachments[0]['name']}"

    tags: list[str] = []
    for tag in json.loads(item["user_tags"]) + (json.loads(derived["tags"]) if derived else []):
        if tag not in tags:
            tags.append(tag)

    link_api = None
    if link:
        url = link["final_url"] or link["url"]
        link_api = {
            "url": url,
            "site": link["site"] or urlparse(url).hostname or "",
            "title": link["title"] or url,
        }

    return {
        "id": item["id"],
        "code": item["short_code"],
        "source": item["source"],
        "partition": item["partition"],
        "partitionSource": item["partition_source"],
        "text": item["text"],
        "title": title or "（空消息）",
        "summary": (derived["summary"] or None) if derived else None,
        "tags": tags,
        "createdAt": item["created_at"],
        "link": link_api,
        "attachments": attachments,
        "todo": {"dueAt": todo["due_at"], "doneAt": todo["done_at"]} if todo else None,
        "reminder": (
            {
                # 延后的那次比原定时间早时，显示延后后的时间
                "remindAt": min(reminder["remind_at"], reminder["snooze_at"] or "9999"),
                "repeat": reminder["repeat"],
                "status": reminder["status"],
                "channel": reminder["channel"],
                "sentAt": reminder["sent_at"],
                "doneAt": reminder["done_at"],
                "lastError": reminder["last_error"],
            }
            if reminder
            else None
        ),
        "processing": _processing(conn, item),
        "ai": {"model": derived["model"], "at": derived["created_at"]} if derived else None,
    }


def list_items(conn: sqlite3.Connection, partition: str, limit: int = 300) -> list[dict[str, Any]]:
    ids = [
        r[0]
        for r in conn.execute(
            "SELECT id FROM items WHERE status = 'active' AND partition = ? "
            "ORDER BY created_at DESC LIMIT ?",
            (partition, limit),
        )
    ]
    items = [i for i in (item_to_api(conn, x) for x in ids) if i]
    if partition == "todo":
        far = "9999"
        items.sort(
            key=lambda i: (
                bool((i["todo"] or {}).get("doneAt")),
                (i["todo"] or {}).get("dueAt") or far,
            )
        )
    elif partition == "reminder":
        items.sort(key=lambda i: (i["reminder"] or {}).get("remindAt") or "9999")
    return items


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    result = dict.fromkeys(PARTITIONS, 0)
    for row in conn.execute(
        "SELECT partition, COUNT(*) FROM items WHERE status = 'active' GROUP BY partition"
    ):
        result[row[0]] = row[1]
    result["secret"] = conn.execute(
        "SELECT COUNT(*) FROM secrets WHERE trashed_at IS NULL"
    ).fetchone()[0]
    return result


def search(conn: sqlite3.Connection, query: str, limit: int = 50) -> list[dict[str, Any]]:
    q = query.strip()
    if not q:
        return []
    if len(q) >= 3:
        # trigram 分词支持任意 3 字以上子串；整体加引号，避免用户输入被当成 FTS 语法
        phrase = '"' + q.replace('"', '""') + '"'
        rows = conn.execute(
            "SELECT item_id FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT ?",
            (phrase, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT item_id FROM search_fts WHERE body LIKE ? ESCAPE '\\' LIMIT ?",
            ("%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%", limit),
        ).fetchall()
    found = [item_to_api(conn, r[0]) for r in rows]
    return sorted((i for i in found if i), key=lambda i: i["createdAt"], reverse=True)


def reindex(conn: sqlite3.Connection, item_id: str) -> None:
    """重建一条条目的全文索引：原文、标题、摘要、标签、网页正文、附件名。"""
    item = conn.execute(
        "SELECT text, user_title, user_tags FROM items WHERE id = ?", (item_id,)
    ).fetchone()
    derived = conn.execute(
        "SELECT title, summary, tags FROM derived WHERE item_id = ?", (item_id,)
    ).fetchone()
    parts = [item["text"], item["user_title"] or "", " ".join(json.loads(item["user_tags"]))]
    if derived:
        parts += [
            derived["title"] or "",
            derived["summary"] or "",
            " ".join(json.loads(derived["tags"])),
        ]
    for link in conn.execute(
        "SELECT title, site, content_text FROM links WHERE item_id = ?", (item_id,)
    ):
        parts += [link["title"] or "", link["site"] or "", (link["content_text"] or "")[:3000]]
    parts += [
        r[0] or ""
        for r in conn.execute("SELECT original_name FROM files WHERE item_id = ?", (item_id,))
    ]
    conn.execute("DELETE FROM search_fts WHERE item_id = ?", (item_id,))
    conn.execute(
        "INSERT INTO search_fts (item_id, body) VALUES (?, ?)",
        (item_id, "\n".join(p for p in parts if p)),
    )


def touch(conn: sqlite3.Connection, item_id: str) -> dict[str, Any]:
    conn.execute("UPDATE items SET updated_at = ? WHERE id = ?", (now_iso(), item_id))
    item = item_to_api(conn, item_id)
    emit(conn, "item.updated", {"item": item})
    return item


def move(conn: sqlite3.Connection, item_id: str, partition: str) -> dict[str, Any] | None:
    if partition not in MOVABLE or item_to_api(conn, item_id) is None:
        return None
    conn.execute("BEGIN")
    try:
        conn.execute(
            "UPDATE items SET partition = ?, partition_source = 'user' WHERE id = ?",
            (partition, item_id),
        )
        if partition == "todo":
            conn.execute("INSERT OR IGNORE INTO todos (item_id) VALUES (?)", (item_id,))
        if partition != "reminder":
            # 移出"提醒"分区后不再到点提醒
            conn.execute(
                "UPDATE reminders SET status = 'cancelled', snooze_at = NULL "
                "WHERE item_id = ? AND status = 'scheduled'",
                (item_id,),
            )
        item = touch(conn, item_id)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return item


def set_todo_done(conn: sqlite3.Connection, item_id: str, done: bool) -> dict[str, Any] | None:
    if not conn.execute("SELECT 1 FROM todos WHERE item_id = ?", (item_id,)).fetchone():
        return None
    conn.execute(
        "UPDATE todos SET done_at = ? WHERE item_id = ?", (now_iso() if done else None, item_id)
    )
    return touch(conn, item_id)


def add_todo(conn: sqlite3.Connection, title: str) -> dict[str, Any]:
    item_id, now = new_id(), now_iso()
    conn.execute("BEGIN")
    try:
        conn.execute(
            "INSERT INTO items (id, short_code, source, kind, partition, partition_source, text, "
            "created_at, updated_at) VALUES (?, ?, 'panel', 'text', 'todo', 'user', ?, ?, ?)",
            (item_id, new_code(conn), title, now, now),
        )
        conn.execute(
            "INSERT INTO item_revisions (item_id, text, created_at) VALUES (?, ?, ?)",
            (item_id, title, now),
        )
        conn.execute("INSERT INTO todos (item_id) VALUES (?)", (item_id,))
        reindex(conn, item_id)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return item_to_api(conn, item_id)
