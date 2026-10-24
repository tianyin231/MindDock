"""条目接口：分区列表、计数、搜索、移动、待办勾选、提醒操作、重试、附件下载。"""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from minddock import items as repo
from minddock import reminders
from minddock.api.deps import get_db, require_user
from minddock.jobs import retry_now
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


@router.get("/files/{file_id}/raw")
async def raw_file(file_id: str, request: Request, download: bool = False) -> FileResponse:
    row = (
        get_db(request)
        .execute("SELECT local_path, original_name, mime, kind FROM files WHERE id = ?", (file_id,))
        .fetchone()
    )
    if row is None or not row["local_path"]:
        raise HTTPException(status_code=404, detail="文件不在本地（可能尚未下载完成）")
    data_dir: Path = request.app.state.config.data_dir.resolve()
    path = (data_dir / row["local_path"]).resolve()
    if not path.is_relative_to(data_dir) or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    inline = not download and row["kind"] in ("image", "video", "audio")
    return FileResponse(
        path,
        media_type=row["mime"] or "application/octet-stream",
        filename=row["original_name"] or path.name,
        content_disposition_type="inline" if inline else "attachment",
    )
