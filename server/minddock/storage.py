"""原件归档：经 OpenList 上传到夸克，记录存储健康状态并在连续失败时告警。

- 远端路径按日期分目录，文件名带时间和编号，停用 MindDock 后在夸克 App 里也能直接找到：
  /MindDock/originals/2026/10/20261023-153012_A3F9_原文件名.jpg
- 上传前先看远端是否已有同样大小的文件（上次已传完但没来得及记录），有就直接记为已上传。
- 上传后核对远端大小，一致才记为已上传；本地原件在确认上传前绝不删除。
"""

import logging
import os
import re
import sqlite3
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

import httpx2

from minddock.config import Settings
from minddock.db import now_iso
from minddock.integrations.openlist import QUARK_MOUNT, OpenListClient, OpenListError
from minddock.items import item_to_api
from minddock.jobs import enqueue, retry_now
from minddock.settings_store import SettingsStore
from minddock.timeutil import parse_iso
from minddock.util import emit, kv_get, kv_set

if TYPE_CHECKING:
    from minddock.notify import Notifier

log = logging.getLogger(__name__)

HEALTH_KEY = "storage.health"
ALERT_AFTER = 3  # 连续失败这么多次才告警，避免偶发网络问题打扰
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class StorageError(RuntimeError):
    pass


def folder_of(cfg: dict[str, Any]) -> str:
    return (cfg.get("folder") or "MindDock").strip("/") or "MindDock"


def remote_path(folder: str, row: sqlite3.Row, code: str, tz: str) -> str:
    moment = parse_iso(row["created_at"]).astimezone(ZoneInfo(tz))
    suffix = Path(row["local_path"] or "").suffix
    name = _UNSAFE.sub("_", row["original_name"] or "").strip(" .") or f"{row['kind']}{suffix}"
    stem, ext = os.path.splitext(name)
    if not ext and suffix:
        ext = suffix
    name = f"{stem[:60]}{ext[:12]}"
    return (
        f"{QUARK_MOUNT}/{folder}/originals/{moment:%Y}/{moment:%m}/"
        f"{moment:%Y%m%d-%H%M%S}_{code}_{name}"
    )


# ---- 健康状态 ----


def health(conn: sqlite3.Connection) -> dict[str, Any]:
    return kv_get(conn, HEALTH_KEY) or {"state": "ok", "failures": 0}


def reset_health(conn: sqlite3.Connection) -> None:
    kv_set(conn, HEALTH_KEY, {"state": "ok", "failures": 0})


# ---- 队列 ----


def enqueue_pending(conn: sqlite3.Connection) -> int:
    """补排上传任务：已下载、未上传、也没有进行中任务的文件（例如配置网盘之前收到的）。"""
    rows = conn.execute(
        "SELECT f.id FROM files f WHERE f.upload_status IN ('pending', 'uploading') "
        "AND f.local_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'upload' "
        "AND j.ref_id = f.id AND j.status IN ('queued', 'running', 'failed'))"
    ).fetchall()
    for row in rows:
        enqueue(conn, "upload", row[0])
    return len(rows)


def retry_upload(conn: sqlite3.Connection, file_id: str) -> None:
    conn.execute(
        "UPDATE files SET upload_status = 'pending' WHERE id = ? AND upload_status != 'uploaded'",
        (file_id,),
    )
    retry_now(conn, "upload", file_id)


def retry_failed(conn: sqlite3.Connection) -> int:
    rows = conn.execute("SELECT id FROM files WHERE upload_status = 'failed'").fetchall()
    for row in rows:
        retry_upload(conn, row[0])
    return len(rows)


def stats(conn: sqlite3.Connection, data_dir: Path) -> dict[str, Any]:
    counts = dict.fromkeys(("pending", "uploading", "uploaded", "failed"), 0)
    for row in conn.execute("SELECT upload_status, COUNT(*) FROM files GROUP BY upload_status"):
        counts[row[0]] = row[1]
    local = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE local_path IS NOT NULL"
    ).fetchone()
    return {"counts": counts, "localFiles": local[0], "localBytes": local[1]}


def _changed(conn: sqlite3.Connection, file_id: str) -> None:
    row = conn.execute("SELECT item_id FROM files WHERE id = ?", (file_id,)).fetchone()
    if row and (item := item_to_api(conn, row[0])):
        emit(conn, "item.updated", {"item": item})


# ---- 上传 ----


class Archiver:
    def __init__(
        self,
        conn: sqlite3.Connection,
        store: SettingsStore,
        http: httpx2.AsyncClient,
        config: Settings,
        notifier: "Notifier | None" = None,
    ):
        self.conn = conn
        self.store = store
        self.http = http
        self.config = config
        self.notifier = notifier
        self._client: OpenListClient | None = None
        self._client_version: str | None = None
        self._seen_version = store.version("storage")

    async def client(self) -> OpenListClient:
        """按面板里的设置挂载夸克；设置变了就重新挂载。"""
        if not self.store.configured("storage"):
            raise StorageError("夸克网盘尚未配置")
        version = self.store.version("storage")
        if self._client is None or version != self._client_version:
            client = OpenListClient(
                self.config.openlist_url, self.config.openlist_admin_password, self.http
            )
            await client.login()
            storage = await client.ensure_quark(self.store.get("storage")["quark_cookie"])
            if storage.get("status") != "work":
                raise StorageError(f"夸克挂载失败：{storage.get('status') or '未知原因'}")
            self._client, self._client_version = client, version
        await self._client.ensure_login()
        return self._client

    def watch_settings(self) -> None:
        """面板里改了网盘设置（例如换了 Cookie）：清除异常状态，失败的文件重新排队。"""
        version = self.store.version("storage")
        if version == self._seen_version:
            return
        self._seen_version = version
        if self.store.configured("storage"):
            reset_health(self.conn)
            count = retry_failed(self.conn) + enqueue_pending(self.conn)
            if count:
                log.info("网盘设置已更新，%d 个文件重新排队上传", count)

    def _set_status(self, file_id: str, status: str) -> None:
        self.conn.execute("UPDATE files SET upload_status = ? WHERE id = ?", (status, file_id))
        _changed(self.conn, file_id)

    async def upload(self, file_id: str) -> None:
        row = self.conn.execute(
            "SELECT f.*, i.short_code FROM files f JOIN items i ON i.id = f.item_id WHERE f.id = ?",
            (file_id,),
        ).fetchone()
        if row is None or row["upload_status"] == "uploaded":
            return
        if not row["local_path"]:
            raise StorageError("原件还没下载完成")
        local = self.config.data_dir / row["local_path"]
        if not local.is_file():
            self._set_status(file_id, "failed")
            raise StorageError("本地原件不存在，无法上传")

        self._set_status(file_id, "uploading")
        try:
            client = await self.client()
            path = remote_path(
                folder_of(self.store.get("storage")), row, row["short_code"], self.config.tz
            )
            parent, name = path.rsplit("/", 1)
            size = local.stat().st_size
            await self._mkdir(client, parent)
            if not await self._has(client, parent, name, size):
                await client.put_file(path, local, size)
                if not await self._has(client, parent, name, size):
                    raise StorageError("上传后在夸克中没有找到大小一致的文件")
        except (StorageError, OpenListError, httpx2.HTTPError, OSError) as exc:
            self._set_status(file_id, "failed")
            await self._failed(str(exc) or type(exc).__name__)
            raise

        self.conn.execute(
            "UPDATE files SET backend = 'quark', remote_path = ?, upload_status = 'uploaded', "
            "uploaded_at = ? WHERE id = ?",
            (path, now_iso(), file_id),
        )
        _changed(self.conn, file_id)
        if health(self.conn).get("failures"):
            reset_health(self.conn)
        log.info("已上传夸克：文件 %s（%d 字节）", file_id, size)

    @staticmethod
    async def _mkdir(client: OpenListClient, path: str) -> None:
        try:
            await client.mkdir(path)
        except OpenListError as exc:
            if "exist" not in str(exc).lower():
                raise

    @staticmethod
    async def _has(client: OpenListClient, parent: str, name: str, size: int) -> bool:
        entries = await client.list_dir(parent)
        return any(e.get("name") == name and e.get("size") == size for e in entries)

    async def _failed(self, error: str) -> None:
        state = health(self.conn)
        state["failures"] = state.get("failures", 0) + 1
        state["error"] = error[:300]
        state["since"] = state.get("since") or now_iso()
        if state["failures"] >= ALERT_AFTER:
            state["state"] = "error"
        alert = state["state"] == "error" and not state.get("alerted")
        if alert:
            state["alerted"] = True
        kv_set(self.conn, HEALTH_KEY, state)
        if alert and self.notifier:
            text = (
                f"⚠️ 夸克网盘连续 {state['failures']} 次上传失败：{state['error']}\n"
                "新收到的文件会先保存在服务器上；请在面板「设置 → 夸克网盘」检查或更新 Cookie，"
                "之后会自动补传。"
            )
            await self.notifier.send(text, email_subject="⚠️ MindDock：夸克网盘上传失败")
