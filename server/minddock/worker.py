"""后台任务执行：下载附件、上传夸克、AI 整理、到点提醒，并在需要时给 QQ 发确认消息。"""

import asyncio
import hashlib
import logging
import mimetypes
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx2

from minddock import reminders
from minddock.config import Settings
from minddock.items import item_to_api
from minddock.jobs import claim, complete, enqueue, fail, requeue_stale
from minddock.notify import Notifier
from minddock.organize import AIError, organize_item
from minddock.qq.replies import prune_inbound
from minddock.settings_store import SettingsStore
from minddock.storage import Archiver, enqueue_pending
from minddock.util import emit, prune_events

log = logging.getLogger(__name__)

MAX_DOWNLOAD = 2 * 1024**3
UPLOAD = ("upload",)


class Worker:
    def __init__(
        self,
        conn: sqlite3.Connection,
        store: SettingsStore,
        http: httpx2.AsyncClient,
        config: Settings,
    ):
        self.conn = conn
        self.store = store
        self.http = http
        self.config = config
        self.notifier = Notifier(conn, store, http)
        self.archiver = Archiver(conn, store, http, config, self.notifier)

    async def run(self, concurrency: int = 3) -> None:
        stale = requeue_stale(self.conn)
        if stale:
            log.info("已把 %d 个中断的任务放回队列", stale)
        # 上传可能持续很久，单独一个消费者处理，不占用 AI 整理和提醒
        await asyncio.gather(
            *(self._consume(exclude=UPLOAD) for _ in range(concurrency)),
            self._consume(only=UPLOAD),
            self._reminders(),
            self._housekeeping(),
        )

    async def _consume(self, *, only: tuple[str, ...] = (), exclude: tuple[str, ...] = ()) -> None:
        while True:
            if only == UPLOAD:
                self.archiver.watch_settings()
            job = claim(self.conn, only=only, exclude=exclude)
            if job is None:
                await asyncio.sleep(1)
                continue
            handler = HANDLERS.get(job.type)
            try:
                if handler is None:
                    raise RuntimeError(f"未知的任务类型：{job.type}")
                await handler(self, job.ref_id)
                complete(self.conn, job)
            except Exception as exc:
                status = fail(self.conn, job, str(exc) or type(exc).__name__)
                log.warning("任务 %s#%s 失败（%s）：%s", job.type, job.id, status, exc)
                if job.type == "organize" and (item := item_to_api(self.conn, job.ref_id)):
                    emit(self.conn, "item.updated", {"item": item})

    async def _reminders(self) -> None:
        """到点的提醒放进任务队列；离下一条提醒不足 30 秒时按它的时间醒来。"""
        while True:
            try:
                reminders.schedule_due(self.conn)
                wait = reminders.seconds_until_next(self.conn)
            except Exception:
                log.exception("检查到期提醒出错")
                wait = 30
            await asyncio.sleep(wait)

    async def _housekeeping(self) -> None:
        while True:
            try:
                prune_events(self.conn)
                prune_inbound(self.conn)
                if self.store.configured("storage"):
                    enqueue_pending(self.conn)
            except Exception:
                log.exception("例行维护出错")
            await asyncio.sleep(600)

    async def notify_owner(self, item_id: str, text: str) -> None:
        """整理结果等确认消息：优先回复在原消息下面，超出回复时效则改发主动消息，不发邮件。"""
        row = self.conn.execute(
            "SELECT source_msg_id FROM items WHERE id = ?", (item_id,)
        ).fetchone()
        if row is not None:
            await self.notifier.send(text, reply_to=row["source_msg_id"])


async def handle_organize(worker: Worker, item_id: str) -> None:
    if not worker.store.configured("ai"):
        raise AIError("AI 模型尚未配置")
    outcome = await organize_item(
        worker.conn, worker.http, worker.store.get("ai"), item_id, worker.config.tz
    )
    if outcome and outcome.follow_up:
        await worker.notify_owner(item_id, outcome.follow_up)


async def handle_download(worker: Worker, file_id: str) -> None:
    row = worker.conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None or row["local_path"]:
        return
    if not row["source_url"]:
        raise RuntimeError("没有下载地址")

    now = datetime.now(UTC)
    suffix = Path(row["original_name"] or "").suffix[:10]
    suffix = suffix or mimetypes.guess_extension(row["mime"] or "") or ""
    relative = Path("staging") / f"{now:%Y}" / f"{now:%m}" / f"{file_id}{suffix}"
    target = worker.config.data_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")

    digest, size = hashlib.sha256(), 0
    async with worker.http.stream(
        "GET", row["source_url"], timeout=httpx2.Timeout(30, read=120)
    ) as resp:
        if resp.status_code != 200:
            raise RuntimeError(f"下载附件失败：HTTP {resp.status_code}")
        mime = row["mime"] or resp.headers.get("content-type", "").split(";")[0] or None
        with partial.open("wb") as out:
            async for chunk in resp.aiter_bytes():
                size += len(chunk)
                if size > MAX_DOWNLOAD:
                    raise RuntimeError("附件超过 2 GB，暂不支持")
                digest.update(chunk)
                out.write(chunk)
    partial.replace(target)

    worker.conn.execute(
        "UPDATE files SET sha256 = ?, size = ?, mime = ?, local_path = ? WHERE id = ?",
        (digest.hexdigest(), size, mime, relative.as_posix(), file_id),
    )
    if worker.store.configured("storage"):
        enqueue(worker.conn, "upload", file_id)
    if item := item_to_api(worker.conn, row["item_id"]):
        emit(worker.conn, "item.updated", {"item": item})


async def handle_upload(worker: Worker, file_id: str) -> None:
    await worker.archiver.upload(file_id)


async def handle_remind(worker: Worker, reminder_id: str) -> None:
    await reminders.deliver(
        worker.conn, worker.notifier, reminder_id, worker.config.tz, worker.config.public_url
    )


HANDLERS: dict[str, Callable[[Worker, str], Awaitable[None]]] = {
    "organize": handle_organize,
    "download": handle_download,
    "remind": handle_remind,
    "upload": handle_upload,
}
