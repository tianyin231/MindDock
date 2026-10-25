"""条目接口：分区列表、收件台、面板投递、计数、搜索、移动、待办勾选、提醒操作、重试、附件下载。"""

from pathlib import Path
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

from minddock import items as repo
from minddock import reminders, vault
from minddock.api.deps import get_db, require_user
from minddock.ingest import Incoming, ingest
from minddock.integrations.openlist import OpenListClient, OpenListError
from minddock.jobs import retry_now
from minddock.secret_rules import EXPLICIT_REASON, detect_secret
from minddock.timeutil import to_utc_iso

router = APIRouter(prefix="/api", tags=["items"], dependencies=[Depends(require_user)])

Partition = Literal["inbox", "note", "bookmark", "todo", "reminder", "file"]


def _found(item: dict | None) -> dict:
    if item is None:
        raise HTTPException(status_code=404, detail="条目不存在")
    return item


@router.get("/counts")
async def counts(request: Request) -> dict:
    return repo.counts(get_db(request))


@router.get("/items")
async def list_items(partition: Partition, request: Request) -> list[dict]:
    return repo.list_items(get_db(request), partition)


@router.get("/timeline")
async def timeline(
    request: Request, before: str | None = None, limit: int = Query(40, ge=1, le=100)
) -> dict:
    return repo.timeline(get_db(request), before, limit)


class NewText(BaseModel):
    text: str = Field(min_length=1, max_length=10000)


@router.post("/items")
async def add_text(body: NewText, request: Request) -> dict:
    """在面板里直接投递一段文字，和发给 QQ 机器人走同一条流程（含密钥识别）。"""
    db = get_db(request)
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="内容不能为空")
    reason = detect_secret(text)
    if reason:
        pk = vault.public_key(db)
        if pk is None:
            raise HTTPException(
                status_code=409,
                detail=f"这条内容{reason}，按密钥处理，但密钥库还没启用，没有保存",
            )
        detected = None if reason == EXPLICIT_REASON else reason
        label, content = vault.split_message(text, False, detected)
        if not content:
            raise HTTPException(
                status_code=422, detail="没有找到要保存的内容。写法：#key 名称，换行后写内容"
            )
        try:
            secret = vault.store_text(db, pk, label, content, source="panel", detected=detected)
        except vault.VaultError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from None
        return {"kind": "secret", "secret": secret}
    result = ingest(db, Incoming(msg_id=None, openid="", content=text), source="panel")
    return {"kind": "item", "item": repo.item_to_api(db, result.item_id)}


@router.get("/items/{item_id}")
async def get_item(item_id: str, request: Request) -> dict:
    return _found(repo.item_to_api(get_db(request), item_id))


@router.get("/search")
async def search(q: str, request: Request) -> list[dict]:
    return repo.search(get_db(request), q[:100])


class MoveBody(BaseModel):
    partition: Literal["note", "bookmark", "todo", "reminder", "file"]


@router.post("/items/{item_id}/move")
async def move(item_id: str, body: MoveBody, request: Request) -> dict:
    return _found(repo.move(get_db(request), item_id, body.partition))


class TodoBody(BaseModel):
    done: bool


@router.post("/items/{item_id}/todo")
async def set_todo(item_id: str, body: TodoBody, request: Request) -> dict:
    return _found(repo.set_todo_done(get_db(request), item_id, body.done))


class NewTodo(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.post("/todos")
async def add_todo(body: NewTodo, request: Request) -> dict:
    return repo.add_todo(get_db(request), body.title.strip())


class ReminderBody(BaseModel):
    action: Literal["done", "snooze", "cancel", "reschedule"]
    minutes: int | None = None
    remind_at: str | None = None
    repeat: Literal["none", "daily", "weekly", "monthly"] = "none"


@router.post("/items/{item_id}/reminder")
async def reminder_action(item_id: str, body: ReminderBody, request: Request) -> dict:
    db = get_db(request)
    _found(repo.item_to_api(db, item_id))
    try:
        if body.action == "done":
            return reminders.mark_done(db, item_id)
        if body.action == "snooze":
            return reminders.snooze(db, item_id, body.minutes or 30)
        if body.action == "cancel":
            return reminders.cancel(db, item_id)
        remind_at = to_utc_iso(body.remind_at, request.app.state.config.tz)
        if remind_at is None:
            raise reminders.ReminderError("提醒时间格式不正确")
        return reminders.reschedule(db, item_id, remind_at, body.repeat)
    except reminders.ReminderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.post("/items/{item_id}/retry")
async def retry(item_id: str, request: Request) -> dict:
    db = get_db(request)
    item = _found(repo.item_to_api(db, item_id))
    if item["partition"] == "inbox":
        db.execute("UPDATE items SET no_ai = 0 WHERE id = ?", (item_id,))
        retry_now(db, "organize", item_id)
    return {"status": "ok"}


def _local(request: Request, relative: str | None) -> Path | None:
    if not relative:
        return None
    data_dir: Path = request.app.state.config.data_dir.resolve()
    path = (data_dir / relative).resolve()
    return path if path.is_relative_to(data_dir) and path.is_file() else None


@router.get("/files/{file_id}/raw")
async def raw_file(file_id: str, request: Request, download: bool = False) -> Response:
    """原件：本地还在就直接返回，否则经 OpenList 从夸克取回（支持 Range，视频可拖动进度）。"""
    row = (
        get_db(request)
        .execute(
            "SELECT local_path, original_name, mime, kind, remote_path FROM files WHERE id = ?",
            (file_id,),
        )
        .fetchone()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="文件不存在")
    inline = not download and row["kind"] in ("image", "video", "audio")
    name = row["original_name"] or file_id
    if path := _local(request, row["local_path"]):
        return FileResponse(
            path,
            media_type=row["mime"] or "application/octet-stream",
            filename=name,
            content_disposition_type="inline" if inline else "attachment",
        )
    if not row["remote_path"]:
        raise HTTPException(status_code=404, detail="文件不在本地（可能尚未下载完成）")
    return await _from_quark(request, row["remote_path"], row["mime"], name, inline)


async def _from_quark(
    request: Request, remote_path: str, mime: str | None, name: str, inline: bool
) -> StreamingResponse:
    config, http = request.app.state.config, request.app.state.http
    client = OpenListClient(config.openlist_url, config.openlist_admin_password, http)
    try:
        await client.login()
        info = await client.stat(remote_path)
    except OpenListError as exc:
        raise HTTPException(status_code=502, detail=f"从夸克取回失败：{exc}") from None
    if not info or not info.get("raw_url"):
        raise HTTPException(status_code=404, detail="夸克中找不到这个文件")

    headers = {"Range": r} if (r := request.headers.get("range")) else {}
    upstream = await http.send(
        http.build_request("GET", info["raw_url"], headers=headers), stream=True
    )
    if upstream.status_code >= 400:
        await upstream.aclose()
        raise HTTPException(
            status_code=502, detail=f"从夸克取回失败（HTTP {upstream.status_code}）"
        )
    passthrough = {
        k: v
        for k in ("content-length", "content-range", "accept-ranges")
        if (v := upstream.headers.get(k))
    }
    disposition = "inline" if inline else "attachment"
    passthrough["content-disposition"] = f"{disposition}; filename*=utf-8''{quote(name)}"
    return StreamingResponse(
        upstream.aiter_bytes(),
        status_code=upstream.status_code,
        media_type=mime or "application/octet-stream",
        headers=passthrough,
        background=BackgroundTask(upstream.aclose),
    )


@router.get("/files/{file_id}/thumb")
async def thumb_file(file_id: str, request: Request) -> FileResponse:
    row = (
        get_db(request).execute("SELECT thumb_path FROM files WHERE id = ?", (file_id,)).fetchone()
    )
    path = _local(request, row["thumb_path"]) if row else None
    if path is None:
        raise HTTPException(status_code=404, detail="没有缩略图")
    return FileResponse(
        path,
        media_type="image/webp",
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )
