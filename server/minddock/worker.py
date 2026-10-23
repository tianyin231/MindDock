"""后台任务执行：下载附件、AI 整理，并在需要时给 QQ 发确认消息。"""

import asyncio
import hashlib
import logging
import mimetypes
import sqlite3
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path

import httpx2

from minddock.bot import OWNER_KEY
from minddock.config import Settings
from minddock.items import item_to_api
from minddock.jobs import claim, complete, fail, requeue_stale
from minddock.organize import AIError, organize_item
from minddock.qq.api import QQApi, QQError
from minddock.settings_store import SettingsStore
from minddock.util import emit, kv_get, prune_events

log = logging.getLogger(__name__)

MAX_DOWNLOAD = 2 * 1024**3


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
        self._qq: QQApi | None = None
        self._qq_version: str | None = None

    def qq(self) -> QQApi | None:
        if not self.store.configured("qq"):
            return None
        version = self.store.version("qq")
        if self._qq is None or version != self._qq_version:
            cfg = self.store.get("qq")
            self._qq = QQApi(cfg["app_id"], cfg["app_secret"], bool(cfg.get("sandbox")), self.http)
            self._qq_version = version
        return self._qq

    async def run(self, concurrency: int = 3) -> None:
        stale = requeue_stale(self.conn)
        if stale:
            log.info("已把 %d 个中断的任务放回队列", stale)
        await asyncio.gather(*(self._consume() for _ in range(concurrency)), self._housekeeping())

    async def _consume(self) -> None:
        while True:
            job = claim(self.conn)
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

    async def _housekeeping(self) -> None:
        while True:
            prune_events(self.conn)
            await asyncio.sleep(600)

    async def notify_owner(self, item_id: str, text: str) -> None:
        """优先作为对原消息的被动回复发送；超出回复时效则改为主动消息。"""
        api, owner = self.qq(), kv_get(self.conn, OWNER_KEY)
        row = self.conn.execute(
            "SELECT source_msg_id, reply_seq FROM items WHERE id = ?", (item_id,)
        ).fetchone()
        if api is None or owner is None or row is None:
            return
        try:
            if row["source_msg_id"]:
                seq = row["reply_seq"] + 1
                self.conn.execute("UPDATE items SET reply_seq = ? WHERE id = ?", (seq, item_id))
                try:
                    await api.send_c2c(owner["openid"], text, row["source_msg_id"], seq)
                    return
                except QQError as exc:
                    log.info("被动回复失败，改发主动消息：%s", exc)
            await api.send_c2c(owner["openid"], text)
        except (QQError, httpx2.HTTPError) as exc:
            log.warning("给主人发消息失败：%s", exc)


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
    if item := item_to_api(worker.conn, row["item_id"]):
        emit(worker.conn, "item.updated", {"item": item})


HANDLERS: dict[str, Callable[[Worker, str], Awaitable[None]]] = {
    "organize": handle_organize,
    "download": handle_download,
}
