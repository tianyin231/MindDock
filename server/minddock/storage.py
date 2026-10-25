"""原件归档：经 OpenList 上传到夸克，记录存储健康状态并在连续失败时告警。

- 远端路径按日期分目录，文件名带时间和编号，停用 MindDock 后在夸克 App 里也能直接找到：
  /MindDock/originals/2026/10/20261023-153012_A3F9_原文件名.jpg
- 上传前先看远端是否已有同样大小的文件（上次已传完但没来得及记录），有就直接记为已上传。
- 上传后核对远端大小，一致才记为已上传；本地原件在确认上传前绝不删除。
- 超过 6 小时没和夸克打过交道就列一次目录，确认 Cookie 仍然有效；失效时立即告警，
  不必等到下次上传失败才发现。
"""

import logging
import os
import re
import shutil
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

import httpx2

from minddock.config import Settings
from minddock.db import now_iso
from minddock.integrations.openlist import (
    QUARK_LOGGED_OUT,
    QUARK_MOUNT,
    OpenListClient,
    OpenListError,
    quark_logged_out,
)
from minddock.items import item_to_api
from minddock.jobs import enqueue, retry_now
from minddock.settings_store import SettingsStore
from minddock.timeutil import parse_iso
from minddock.util import emit, kv_get, kv_set

if TYPE_CHECKING:
    from minddock.notify import Notifier

log = logging.getLogger(__name__)

HEALTH_KEY = "storage.health"
VERIFIED_KEY = "storage.verified"  # 最近一次和夸克的交互：{"at": 时间, "ok": 是否成功}
ALERT_AFTER = 3  # 连续失败这么多次才告警，避免偶发网络问题打扰；登录失效是确定的，立即告警
CHECK_EVERY = 6 * 3600
RECHECK_AFTER_FAILURE = 3600
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


def verified(conn: sqlite3.Connection) -> dict[str, Any] | None:
    return kv_get(conn, VERIFIED_KEY)


def _mark_verified(conn: sqlite3.Connection, ok: bool) -> None:
    kv_set(conn, VERIFIED_KEY, {"at": now_iso(), "ok": ok})


def check_due(conn: sqlite3.Connection) -> bool:
    last = verified(conn)
    if last is None:
        return True
    wait = CHECK_EVERY if last["ok"] else RECHECK_AFTER_FAILURE
    return parse_iso(last["at"]) <= parse_iso(now_iso(-wait))


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


def cleanup_local(
    conn: sqlite3.Connection,
    data_dir: Path,
    keep_days: int,
    min_free_ratio: float,
    disk_usage: Callable[[Path], Any] = shutil.disk_usage,
) -> int:
    """删除已确认上传的本地原件：超过保留天数的，以及磁盘紧张时最旧的。返回删除数量。

    只处理 upload_status = 'uploaded' 的文件，未确认上传的原件绝不删除；缩略图保留。
    """
    removed = 0
    expired = conn.execute(
        "SELECT id, local_path FROM files WHERE upload_status = 'uploaded' "
        "AND local_path IS NOT NULL AND uploaded_at < ? ORDER BY uploaded_at",
        (now_iso(-keep_days * 86400),),
    ).fetchall()
    for row in expired:
        removed += _drop_local(conn, data_dir, row["id"], row["local_path"])

    def short_of_space() -> bool:
        usage = disk_usage(data_dir)
        return usage.free / usage.total < min_free_ratio

    if short_of_space():
        oldest = conn.execute(
            "SELECT id, local_path FROM files WHERE upload_status = 'uploaded' "
            "AND local_path IS NOT NULL ORDER BY uploaded_at"
        ).fetchall()
        for row in oldest:
            if not short_of_space():
                break
            removed += _drop_local(conn, data_dir, row["id"], row["local_path"])
    if removed:
        log.info("已清理 %d 个已上传的本地原件", removed)
    return removed


def _drop_local(conn: sqlite3.Connection, data_dir: Path, file_id: str, local_path: str) -> int:
    path = (data_dir / local_path).resolve()
    if path.is_relative_to(data_dir.resolve()):
        path.unlink(missing_ok=True)
    conn.execute("UPDATE files SET local_path = NULL WHERE id = ?", (file_id,))
    _changed(conn, file_id)
    return 1


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
            kv_set(self.conn, VERIFIED_KEY, None)  # 下次例行维护时立即用新 Cookie 检查一次
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
            size = local.stat().st_size
            await self.put_verified(client, path, local)
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
        _mark_verified(self.conn, True)
        if health(self.conn).get("failures"):
            reset_health(self.conn)
        log.info("已上传夸克：文件 %s（%d 字节）", file_id, size)

    async def put_verified(self, client: OpenListClient, path: str, local: Path) -> None:
        """上传到夸克并核对大小；远端已有大小一致的同名文件就跳过。"""
        parent, name = path.rsplit("/", 1)
        size = local.stat().st_size
        await self._mkdir(client, parent)
        if not await self._has(client, parent, name, size):
            await client.put_file(path, local, size)
            if not await self._has(client, parent, name, size):
                raise StorageError("上传后在夸克中没有找到大小一致的文件")

    async def check_login(self) -> bool:
        """列一次夸克根目录（不走 OpenList 缓存），确认 Cookie 仍然有效。"""
        try:
            client = await self.client()
            await client.list_dir(QUARK_MOUNT)
        except (StorageError, OpenListError, httpx2.HTTPError) as exc:
            _mark_verified(self.conn, False)
            await self._failed(str(exc) or type(exc).__name__, source="check")
            log.warning("夸克登录状态检查失败：%s", exc)
            return False
        _mark_verified(self.conn, True)
        # 只清除检查自己记下的失败和登录失效；上传本身的问题（如空间不足）要等上传成功才算恢复
        state = health(self.conn)
        if state.get("failures") and (
            state.get("source") == "check" or state.get("reason") == "login"
        ):
            reset_health(self.conn)
        return True

    async def check_if_due(self) -> None:
        if self.store.configured("storage") and check_due(self.conn):
            await self.check_login()

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

    async def _failed(self, error: str, *, source: str = "upload") -> None:
        logged_out = quark_logged_out(error)
        state = health(self.conn)
        state["failures"] = state.get("failures", 0) + 1
        state["error"] = QUARK_LOGGED_OUT if logged_out else error[:300]
        state["reason"] = "login" if logged_out else "error"
        state["source"] = source
        state["since"] = state.get("since") or now_iso()
        if logged_out or state["failures"] >= ALERT_AFTER:
            state["state"] = "error"
        alert = state["state"] == "error" and not state.get("alerted")
        if alert:
            state["alerted"] = True
        kv_set(self.conn, HEALTH_KEY, state)
        if alert and self.notifier:
            if logged_out:
                headline = "⚠️ 夸克网盘的登录已失效（Cookie 被退出或过期）"
                subject = "⚠️ MindDock：夸克网盘登录已失效"
            else:
                headline = f"⚠️ 夸克网盘连续 {state['failures']} 次出错：{state['error']}"
                subject = "⚠️ MindDock：夸克网盘上传失败"
            text = (
                f"{headline}\n"
                "新收到的文件会先保存在服务器上；请在面板「设置 → 夸克网盘」检查或更新 Cookie，"
                "之后会自动补传。"
            )
            await self.notifier.send(text, email_subject=subject)
