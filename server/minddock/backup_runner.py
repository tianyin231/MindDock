"""每日备份：到点生成加密备份，上传夸克并清理远端旧备份；失败时告警一次。

时间表：每天 03:15 之后的第一次例行维护（每 10 分钟一次）。从没成功备份过时立即做一份，
不用等到凌晨；失败后每小时重试。远端保留最近 30 份，再加最近 12 个月每月最后一份。
"""

import asyncio
import logging
import sqlite3
from datetime import UTC, datetime, time
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

import httpx2

from minddock import backup
from minddock.config import Settings
from minddock.db import connect, now_iso
from minddock.integrations.openlist import QUARK_MOUNT, OpenListClient, OpenListError
from minddock.storage import StorageError, folder_of
from minddock.timeutil import parse_iso

if TYPE_CHECKING:
    from minddock.worker import Worker

log = logging.getLogger(__name__)

SCHEDULE = time(3, 15)
RETRY_AFTER = 3600
REMOTE_KEEP = 30
REMOTE_KEEP_MONTHS = 12


def due(conn: sqlite3.Connection, config: Settings, now: datetime | None = None) -> bool:
    if not config.backup_recipient:
        return False
    tz = ZoneInfo(config.tz)
    now = now or datetime.now(UTC)
    local_now = now.astimezone(tz)
    state = backup.status(conn)
    failed = state.get("failedAt")
    if failed and (now - parse_iso(failed)).total_seconds() < RETRY_AFTER:
        return False
    last = (state.get("last") or {}).get("createdAt")
    if not last:
        return True
    if local_now.time() < SCHEDULE:
        return False
    return datetime.fromisoformat(last).astimezone(tz).date() < local_now.date()


def remote_dir(cfg: dict[str, Any]) -> str:
    return f"{QUARK_MOUNT}/{folder_of(cfg)}/backups"


def to_prune(names: list[str]) -> list[str]:
    """远端要删除的旧备份：保留最近 REMOTE_KEEP 份，以及最近几个月每月最新的一份。"""
    backups = sorted((n for n in names if backup.NAME_RE.match(n)), reverse=True)
    keep = set(backups[:REMOTE_KEEP])
    monthly: dict[str, str] = {}
    for name in backups:
        monthly.setdefault(name[9:15], name)  # minddock-YYYYMM…
    keep.update(monthly[m] for m in sorted(monthly, reverse=True)[:REMOTE_KEEP_MONTHS])
    return [n for n in backups if n not in keep]


async def _upload(worker: "Worker", name: str) -> str:
    client: OpenListClient = await worker.archiver.client()
    parent = remote_dir(worker.store.get("storage"))
    path = f"{parent}/{name}"
    local = worker.config.data_dir / backup.BACKUP_DIR / name
    await worker.archiver.put_verified(client, path, local)
    stale = to_prune([e.get("name", "") for e in await client.list_dir(parent)])
    if stale:
        await client.remove(parent, stale)
        log.info("已清理夸克上的 %d 份旧备份", len(stale))
    return path


async def run(worker: "Worker") -> dict[str, Any] | None:
    """生成一份备份并上传。失败时记录状态、告警，返回 None。"""
    conn = connect(worker.config.db_path)  # 在线程里用独立的连接
    try:
        result = await asyncio.to_thread(backup.create_backup, conn, worker.config)
    except backup.BackupError as exc:
        await _failed(worker, str(exc))
        return None
    finally:
        conn.close()
    backup.record(worker.conn, ok=True, error=None, failedAt=None, alerted=False, last=result)
    log.info("已生成备份 %s（%d 字节）", result["name"], result["size"])

    if worker.store.configured("storage"):
        try:
            path = await _upload(worker, result["name"])
            remote = {"ok": True, "at": now_iso(), "path": path, "name": result["name"]}
        except (StorageError, OpenListError, httpx2.HTTPError, OSError) as exc:
            # 本地备份已经成功；夸克本身的问题由原件上传那边告警，这里只记录
            remote = {"ok": False, "at": now_iso(), "error": (str(exc) or type(exc).__name__)[:300]}
            log.warning("备份上传夸克失败：%s", exc)
        backup.record(worker.conn, remote=remote)
    return result


async def _failed(worker: "Worker", error: str) -> None:
    state = backup.status(worker.conn)
    backup.record(worker.conn, ok=False, error=error[:300], failedAt=now_iso(), alerted=True)
    log.warning("备份失败：%s", error)
    if not state.get("alerted"):
        await worker.notifier.send(
            f"⚠️ MindDock 备份失败：{error[:200]}\n每小时会自动重试，可以在面板「设置 → 备份」查看。",
            email_subject="⚠️ MindDock：备份失败",
        )


async def run_if_due(worker: "Worker") -> None:
    if due(worker.conn, worker.config):
        await run(worker)
