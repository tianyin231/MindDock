"""AI 整理：把一条消息归入分区，生成标题、摘要、标签，并解析待办截止和提醒时间。

AI 结果单独写进 derived 表，原文从不修改；用户手动改过分区的条目不会被 AI 覆盖分区。
"""

import json
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Literal

import httpx2
from pydantic import BaseModel, Field, ValidationError

from minddock.db import now_iso
from minddock.integrations.probes import error_text
from minddock.items import URL_RE, item_to_api, reindex
from minddock.links import fetch_page
from minddock.timeutil import describe_now, friendly, to_utc_iso
from minddock.util import emit, new_id

PROMPT_VERSION = "2026-10-24.2"

SYSTEM_PROMPT = """你是 MindDock 的整理助手。用户把各种内容随手发给自己，你负责把每条消息归入一个分区，并提取标题、摘要、标签和时间。

分区（partition）：
- note：想法、感悟、随手记、读书笔记等不需要行动的记录
- bookmark：网页链接、文章、视频、值得留存的资料（消息以链接为主时通常归这里）
- todo：需要用户去做的事，可能带截止时间
- reminder：明确要求在某个时间提醒的事（如"提醒我""到点叫我""每天 8 点"）
- file：以图片、视频、文档等附件为主、文字很少的消息

规则：
1. 只输出 JSON 对象，不要输出其他内容。
2. title：不超过 30 个字，写事情本身，不要带"提醒""待办""笔记""收藏"等分区词（例如写"交周报"，不写"提醒交周报"）；summary：不超过 100 个字，内容很短时为空字符串。
3. tags：最多 5 个简短的中文名词，描述主题；不要用分区名做标签，拿不准就少给；优先复用已有标签：{tags}
4. 时间一律按 {tz} 理解，输出带时区偏移的 ISO 8601，例如 2026-10-24T15:00:00+08:00。现在是 {now}。
5. reminder 必须给出 remind_at；todo 有截止时间时给出 due_at，否则为 null。
6. 只说了钟点没说日期时：今天该时刻还没到就是今天，否则是明天。
7. repeat：每天/每周/每月重复的提醒分别填 daily/weekly/monthly，否则填 none。"""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "partition": {"type": "string", "enum": ["note", "bookmark", "todo", "reminder", "file"]},
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "due_at": {"type": ["string", "null"]},
        "remind_at": {"type": ["string", "null"]},
        "repeat": {"type": "string", "enum": ["none", "daily", "weekly", "monthly"]},
    },
    "required": ["partition", "title", "summary", "tags", "due_at", "remind_at", "repeat"],
    "additionalProperties": False,
}


class AIError(RuntimeError):
    pass


class Organized(BaseModel):
    partition: Literal["note", "bookmark", "todo", "reminder", "file"]
    title: str = Field(min_length=1)
    summary: str = ""
    tags: list[str] = []
    due_at: str | None = None
    remind_at: str | None = None
    repeat: Literal["none", "daily", "weekly", "monthly"] = "none"


@dataclass
class OrganizeOutcome:
    item: dict[str, Any]
    follow_up: str | None


def parse_json_reply(text: str) -> dict[str, Any]:
    """容忍模型在 JSON 前后输出思考过程或代码块标记。"""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise AIError("模型没有返回 JSON")
    try:
        return json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise AIError(f"模型返回的 JSON 无法解析：{exc}") from None


async def chat_json(
    cfg: dict[str, Any], http: httpx2.AsyncClient, system: str, user: str
) -> dict[str, Any]:
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {cfg['api_key']}"}
    base = {
        "model": cfg["model_text"],
        "temperature": 0.2,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    formats: list[dict[str, Any] | None] = [
        {
            "type": "json_schema",
            "json_schema": {"name": "organize", "strict": True, "schema": SCHEMA},
        },
        {"type": "json_object"},
        None,
    ]
    last_error = ""
    for fmt in formats:
        body = {**base, "response_format": fmt} if fmt else base
        resp = await http.post(url, headers=headers, json=body, timeout=90)
        if resp.status_code == 400 and fmt is not None:
            last_error = error_text(resp)  # 接口不支持这种输出格式，降一级再试
            continue
        if resp.status_code != 200:
            raise AIError(f"AI 接口返回 HTTP {resp.status_code}：{error_text(resp)}")
        try:
            content = resp.json()["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, ValueError):
            raise AIError("AI 接口返回格式异常") from None
        return parse_json_reply(content)
    raise AIError(f"AI 接口拒绝了请求：{last_error}")


def _top_tags(conn: sqlite3.Connection, limit: int = 30) -> list[str]:
    rows = conn.execute(
        "SELECT j.value, COUNT(*) AS n FROM derived, json_each(derived.tags) AS j "
        "GROUP BY j.value ORDER BY n DESC LIMIT ?",
        (limit,),
    )
    return [r[0] for r in rows]


async def _ensure_links(
    conn: sqlite3.Connection, http: httpx2.AsyncClient, item: sqlite3.Row
) -> None:
    for url in URL_RE.findall(item["text"])[:2]:
        if conn.execute(
            "SELECT 1 FROM links WHERE item_id = ? AND url = ?", (item["id"], url)
        ).fetchone():
            continue
        try:
            page = await fetch_page(http, url)
            conn.execute(
                "INSERT INTO links (item_id, url, final_url, title, site, content_text, fetch_status, "
                "fetched_at) VALUES (?, ?, ?, ?, ?, ?, 'ok', ?)",
                (item["id"], url, page.final_url, page.title, page.site, page.text, now_iso()),
            )
        except Exception:  # 网页打不开不影响归类
            conn.execute(
                "INSERT INTO links (item_id, url, fetch_status, fetched_at) VALUES (?, ?, 'failed', ?)",
                (item["id"], url, now_iso()),
            )


def _user_prompt(conn: sqlite3.Connection, item: sqlite3.Row) -> str:
    lines = ["消息原文：", item["text"] or "（无文字）"]
    files = conn.execute(
        "SELECT kind, original_name FROM files WHERE item_id = ?", (item["id"],)
    ).fetchall()
    if files:
        lines += [
            "",
            "附件：" + "、".join(f"{f['kind']}:{f['original_name'] or '未命名'}" for f in files),
        ]
    for link in conn.execute(
        "SELECT title, site, content_text FROM links WHERE item_id = ? AND fetch_status = 'ok'",
        (item["id"],),
    ):
        lines += ["", f"网页（{link['site']}）：{link['title'] or ''}"]
        if link["content_text"]:
            lines.append("正文摘录：" + link["content_text"][:3000])
    return "\n".join(lines)


async def organize_item(
    conn: sqlite3.Connection,
    http: httpx2.AsyncClient,
    ai_cfg: dict[str, Any],
    item_id: str,
    tz: str,
) -> OrganizeOutcome | None:
    item = conn.execute(
        "SELECT * FROM items WHERE id = ? AND status = 'active'", (item_id,)
    ).fetchone()
    if item is None:
        return None

    await _ensure_links(conn, http, item)
    system = SYSTEM_PROMPT.format(
        tags="、".join(_top_tags(conn)) or "（暂无）", tz=tz, now=describe_now(tz)
    )
    data = await chat_json(ai_cfg, http, system, _user_prompt(conn, item))
    try:
        result = Organized.model_validate(data)
    except ValidationError as exc:
        raise AIError(f"模型返回的字段不符合要求：{exc.errors()[0]['msg']}") from None

    partition = result.partition
    remind_at = to_utc_iso(result.remind_at, tz)
    due_at = to_utc_iso(result.due_at, tz)
    has_files = conn.execute("SELECT 1 FROM files WHERE item_id = ?", (item_id,)).fetchone()
    note = None
    if partition == "reminder" and (not remind_at or remind_at < now_iso(-60)):
        partition, note = "todo", "没识别出有效的提醒时间，已先记为待办"
    if partition == "file" and not has_files:
        partition = "note"

    title = result.title.strip()[:40]
    tags = [t.strip().lstrip("#")[:20] for t in result.tags if t.strip()][:5]
    keep_user_choice = item["partition_source"] == "user" and item["partition"] != "inbox"
    final = item["partition"] if keep_user_choice else partition

    conn.execute("BEGIN")
    try:
        conn.execute(
            "INSERT INTO derived (item_id, partition, title, summary, tags, model, prompt_version, "
            "created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET "
            "partition = excluded.partition, title = excluded.title, summary = excluded.summary, "
            "tags = excluded.tags, model = excluded.model, prompt_version = excluded.prompt_version, "
            "created_at = excluded.created_at",
            (
                item_id,
                partition,
                title,
                result.summary.strip()[:200],
                json.dumps(tags, ensure_ascii=False),
                ai_cfg["model_text"],
                PROMPT_VERSION,
                now_iso(),
            ),
        )
        conn.execute(
            "UPDATE items SET partition = ?, updated_at = ? WHERE id = ?",
            (final, now_iso(), item_id),
        )
        if final == "todo":
            conn.execute(
                "INSERT INTO todos (item_id, due_at) VALUES (?, ?) "
                "ON CONFLICT (item_id) DO UPDATE SET due_at = COALESCE(todos.due_at, excluded.due_at)",
                (item_id, due_at),
            )
        if (
            final == "reminder"
            and remind_at
            and not conn.execute(
                "SELECT 1 FROM reminders WHERE item_id = ? AND status = 'scheduled'", (item_id,)
            ).fetchone()
        ):
            conn.execute(
                "INSERT INTO reminders (id, item_id, remind_at, repeat, created_at) VALUES (?, ?, ?, ?, ?)",
                (new_id(), item_id, remind_at, result.repeat, now_iso()),
            )
        reindex(conn, item_id)
        api_item = item_to_api(conn, item_id)
        emit(conn, "item.classified", {"item": api_item})
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    code = item["short_code"]
    follow_up = None
    if final == "reminder" and remind_at:
        repeat = {"daily": "，每天重复", "weekly": "，每周重复", "monthly": "，每月重复"}.get(
            result.repeat, ""
        )
        follow_up = f"⏰ #{code} 已设提醒：{friendly(remind_at, tz)}{repeat}"
    elif final == "todo" and (due_at or note):
        follow_up = f"📋 #{code} " + (note if note else f"已记为待办，截止 {friendly(due_at, tz)}")
    return OrganizeOutcome(api_item, follow_up)
