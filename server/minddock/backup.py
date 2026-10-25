"""加密备份与恢复。

备份包是用 age 公钥加密的 tar.gz，私钥只在你手里（KeePassXC 等），服务器上只有公钥。
不依赖 MindDock 也能用标准的 age / rage 工具解开：

    age -d -i 私钥文件 minddock-20261025-031500.tar.gz.age | tar -xz

包里的内容：

    manifest.json   版本、数据库版本、数量统计、每个文件的大小与 SHA-256
    minddock.db     数据库快照（SQLite 在线备份，已做完整性检查）
    deploy.env      部署配置（加密主密钥等），恢复到新服务器时写回 .env
    data/...        密钥类文件的密文、还没上传夸克的原件、缩略图

已经上传夸克的原件不进备份，恢复后经 OpenList 从夸克取回。
"""

import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pyrage
from pyrage import x25519

from minddock.config import Settings
from minddock.db import latest_version
from minddock.util import kv_get, kv_set

FORMAT = 1
BACKUP_DIR = "backups"
NAME_RE = re.compile(r"^minddock-(\d{8})-(\d{6})\.tar\.gz\.age$")
STATUS_KEY = "backup.status"
RESTORED_ENV = "restored.env"
# 带到新服务器的部署配置；新服务器的域名以安装时指定的为准
ENV_KEYS = (
    "MINDDOCK_DOMAIN",
    "MINDDOCK_PUBLIC_URL",
    "MINDDOCK_TAG",
    "MINDDOCK_SECRET_KEY",
    "MINDDOCK_OPENLIST_ADMIN_PASSWORD",
    "MINDDOCK_BACKUP_RECIPIENT",
    "TZ",
)
LOCK_STALE_SECONDS = 3600
_TOP_LEVEL = {"manifest.json", "deploy.env", "minddock.db"}
# 备份里的文件只可能来自这几个目录（密钥密文、本地暂存的原件、缩略图）
_DATA_DIRS = {"vault", "staging", "thumbs"}


class BackupError(Exception):
    pass


class RestoreError(BackupError):
    pass


# ---- 密钥 ----


def generate_keypair() -> tuple[str, str]:
    """返回（公钥，私钥）。私钥文件的写法与 age-keygen 相同，可直接用于 age -d -i。"""
    identity = x25519.Identity.generate()
    return str(identity.to_public()), str(identity)


def parse_identity(text: str) -> x25519.Identity:
    """接受私钥本身，或 age-keygen 生成的整个文件内容（含注释行）。"""
    for line in text.splitlines():
        line = line.strip()
        if line.upper().startswith("AGE-SECRET-KEY-"):
            try:
                return x25519.Identity.from_str(line)
            except pyrage.IdentityError:
                break
    raise RestoreError("没有找到有效的备份私钥（以 AGE-SECRET-KEY- 开头的一行）")


def parse_recipient(text: str) -> x25519.Recipient:
    try:
        return x25519.Recipient.from_str(text.strip())
    except pyrage.RecipientError:
        raise BackupError("备份公钥格式不正确（应以 age1 开头）") from None


# ---- 状态 ----


def status(conn: sqlite3.Connection) -> dict[str, Any]:
    return kv_get(conn, STATUS_KEY, {})


def record(conn: sqlite3.Connection, **fields: Any) -> None:
    kv_set(conn, STATUS_KEY, {**status(conn), **fields})


def list_local(data_dir: Path) -> list[dict[str, Any]]:
    root = data_dir / BACKUP_DIR
    if not root.is_dir():
        return []
    found = [
        {"name": p.name, "size": p.stat().st_size}
        for p in root.iterdir()
        if p.is_file() and NAME_RE.match(p.name)
    ]
    return sorted(found, key=lambda f: f["name"], reverse=True)


def local_path(data_dir: Path, name: str) -> Path | None:
    """按文件名找本地备份；名称不合规时返回 None，防止路径穿越。"""
    if not NAME_RE.match(name):
        return None
    path = data_dir / BACKUP_DIR / name
    return path if path.is_file() else None


# ---- 备份 ----


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _integrity(path: Path) -> str:
    db = sqlite3.connect(path)
    try:
        return db.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        db.close()


def _snapshot(conn: sqlite3.Connection, target: Path) -> None:
    dest = sqlite3.connect(target)
    try:
        # 在线备份得到一致的快照，期间其他进程照常读写
        conn.backup(dest)
    finally:
        dest.close()
    result = _integrity(target)
    if result != "ok":
        raise BackupError(f"数据库快照完整性检查失败：{result}")


def _referenced_files(snapshot: Path) -> tuple[int, dict[str, int], list[str]]:
    db = sqlite3.connect(snapshot)
    try:
        schema = db.execute("PRAGMA user_version").fetchone()[0]
        counts = {
            "items": db.execute("SELECT COUNT(*) FROM items WHERE status = 'active'").fetchone()[0],
            "secrets": db.execute(
                "SELECT COUNT(*) FROM secrets WHERE trashed_at IS NULL"
            ).fetchone()[0],
            "files": db.execute("SELECT COUNT(*) FROM files").fetchone()[0],
        }
        queries = (
            "SELECT blob_path FROM secrets WHERE blob_path IS NOT NULL",
            # 已上传的原件在夸克里，不重复备份
            "SELECT local_path FROM files "
            "WHERE local_path IS NOT NULL AND upload_status != 'uploaded'",
            "SELECT thumb_path FROM files WHERE thumb_path IS NOT NULL",
        )
        paths = {row[0] for sql in queries for row in db.execute(sql)}
    finally:
        db.close()
    return schema, counts, sorted(paths)


def _env_snapshot() -> str:
    return "".join(f"{k}={os.environ[k]}\n" for k in ENV_KEYS if os.environ.get(k))


def _add_bytes(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = int(time.time())
    info.mode = 0o600
    tar.addfile(info, io.BytesIO(data))


class _Lock:
    """同一时间只跑一个备份（命令行和后台任务可能撞上）。"""

    def __init__(self, path: Path):
        self.path = path

    def __enter__(self) -> "_Lock":
        try:
            if time.time() - self.path.stat().st_mtime > LOCK_STALE_SECONDS:
                self.path.unlink()
        except FileNotFoundError:
            pass
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise BackupError("另一个备份正在进行，请稍后再试") from None
        os.close(fd)
        return self

    def __exit__(self, *exc: object) -> None:
        self.path.unlink(missing_ok=True)


def create_backup(
    conn: sqlite3.Connection, config: Settings, *, now: datetime | None = None
) -> dict[str, Any]:
    if not config.backup_recipient:
        raise BackupError("没有配置备份公钥（.env 中的 MINDDOCK_BACKUP_RECIPIENT）")
    recipient = parse_recipient(config.backup_recipient)
    data_dir = config.data_dir.resolve()
    root = data_dir / BACKUP_DIR
    root.mkdir(parents=True, exist_ok=True)
    moment = now or datetime.now(ZoneInfo(config.tz))
    name = f"minddock-{moment:%Y%m%d-%H%M%S}.tar.gz.age"
    target = root / name

    with _Lock(root / ".lock"):
        work = Path(tempfile.mkdtemp(prefix=".tmp-", dir=root))
        try:
            snapshot = work / "minddock.db"
            _snapshot(conn, snapshot)
            schema, counts, paths = _referenced_files(snapshot)

            files, missing = [], []
            for rel in paths:
                path = (data_dir / rel).resolve()
                if path.is_relative_to(data_dir) and path.is_file():
                    files.append(
                        {"path": rel, "size": path.stat().st_size, "sha256": _sha256(path)}
                    )
                else:
                    missing.append(rel)
            manifest = {
                "format": FORMAT,
                "createdAt": moment.isoformat(timespec="seconds"),
                "version": config.version,
                "commit": config.commit,
                "schema": schema,
                "counts": counts,
                "database": {"size": snapshot.stat().st_size, "sha256": _sha256(snapshot)},
                "files": files,
                "missing": missing,
            }

            plain = work / "backup.tar.gz"
            try:
                with tarfile.open(plain, "w:gz", compresslevel=6) as tar:
                    _add_bytes(tar, "manifest.json", json.dumps(manifest, indent=2).encode())
                    _add_bytes(tar, "deploy.env", _env_snapshot().encode())
                    tar.add(snapshot, "minddock.db")
                    for f in files:
                        tar.add(data_dir / f["path"], f"data/{f['path']}")
            except OSError as exc:
                raise BackupError(f"打包失败：{exc}") from None

            partial = root / f".{name}.part"
            with plain.open("rb") as src, partial.open("wb") as dst:
                pyrage.encrypt_io(src, dst, [recipient])
            os.chmod(partial, 0o600)
            partial.replace(target)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    prune_local(data_dir, config.backup_keep_local)
    return {
        "name": name,
        "size": target.stat().st_size,
        "createdAt": manifest["createdAt"],
        "counts": counts,
        "files": len(files),
        "missing": len(missing),
    }


def prune_local(data_dir: Path, keep: int) -> list[str]:
    """本地只保留最近 keep 份；顺带清掉中断留下的临时文件。"""
    root = data_dir / BACKUP_DIR
    removed = [b["name"] for b in list_local(data_dir)[max(keep, 1) :]]
    for name in removed:
        (root / name).unlink(missing_ok=True)
    day_ago = time.time() - 86400
    for leftover in root.glob(".*"):
        if leftover.name != ".lock" and leftover.stat().st_mtime < day_ago:
            if leftover.is_dir():
                shutil.rmtree(leftover, ignore_errors=True)
            else:
                leftover.unlink(missing_ok=True)
    return removed


# ---- 恢复 ----


def _check_members(tar: tarfile.TarFile) -> None:
    for member in tar.getmembers():
        name = member.name
        allowed = name in _TOP_LEVEL or name.startswith("data/")
        if not allowed or not (member.isfile() or member.isdir()):
            raise RestoreError(f"备份包里有意外的内容：{name}")


def _reconcile(db_path: Path, data_dir: Path) -> dict[str, int]:
    """数据库里记着的本地文件不在备份里时清掉记录：已上传的原件改从夸克取回，缩略图不再显示。"""
    db = sqlite3.connect(db_path)
    remote = lost = thumbs = 0
    try:
        rows = db.execute(
            "SELECT id, local_path, thumb_path, upload_status FROM files "
            "WHERE local_path IS NOT NULL OR thumb_path IS NOT NULL"
        ).fetchall()
        for file_id, local, thumb, upload_status in rows:
            if local and not (data_dir / local).is_file():
                db.execute("UPDATE files SET local_path = NULL WHERE id = ?", (file_id,))
                if upload_status == "uploaded":
                    remote += 1
                else:
                    lost += 1
            if thumb and not (data_dir / thumb).is_file():
                db.execute("UPDATE files SET thumb_path = NULL WHERE id = ?", (file_id,))
                thumbs += 1
        db.commit()
    finally:
        db.close()
    return {"remote": remote, "lost": lost, "thumbs": thumbs}


def restore_backup(
    archive: Path, identity: str, data_dir: Path, *, force: bool = False
) -> dict[str, Any]:
    """把备份恢复到 data_dir。部署配置写到 data_dir/restored.env，由 install.sh 合并进 .env。"""
    key = parse_identity(identity)
    data_dir.mkdir(parents=True, exist_ok=True)
    data_dir = data_dir.resolve()
    db_target = data_dir / "minddock.db"
    if db_target.exists() and not force:
        raise RestoreError(f"{db_target} 已存在，恢复会覆盖现有数据；确认要覆盖请加 --force")

    work = Path(tempfile.mkdtemp(prefix=".restore-", dir=data_dir))
    try:
        plain = work / "backup.tar.gz"
        try:
            with archive.open("rb") as src, plain.open("wb") as dst:
                pyrage.decrypt_io(src, dst, [key])
        except pyrage.DecryptError:
            raise RestoreError("解密失败：私钥与这份备份不匹配，或文件已损坏") from None

        out = work / "x"
        try:
            with tarfile.open(plain, "r:gz") as tar:
                _check_members(tar)
                tar.extractall(out, filter="data")
        except (tarfile.TarError, OSError) as exc:
            raise RestoreError(f"备份包无法解开：{exc}") from None

        try:
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise RestoreError("备份包缺少有效的 manifest.json") from None
        if manifest.get("format") != FORMAT:
            raise RestoreError(f"不认识的备份格式：{manifest.get('format')}")
        if manifest["schema"] > latest_version():
            raise RestoreError(
                f"这份备份来自更新的版本（数据库版本 {manifest['schema']}），请先更新镜像再恢复"
            )

        db = out / "minddock.db"
        if not db.is_file() or _sha256(db) != manifest["database"]["sha256"]:
            raise RestoreError("数据库文件校验失败")
        if (result := _integrity(db)) != "ok":
            raise RestoreError(f"数据库完整性检查失败：{result}")
        moves = []
        for f in manifest["files"]:
            src = out / "data" / f["path"]
            dest = (data_dir / f["path"]).resolve()
            relative = dest.relative_to(data_dir).parts if dest.is_relative_to(data_dir) else ()
            if len(relative) < 2 or relative[0] not in _DATA_DIRS:
                raise RestoreError(f"文件路径不合法：{f['path']}")
            if not src.is_file() or _sha256(src) != f["sha256"]:
                raise RestoreError(f"文件校验失败：{f['path']}")
            moves.append((src, dest))

        # 全部校验通过后才动现有数据
        for suffix in ("-wal", "-shm"):
            (data_dir / f"minddock.db{suffix}").unlink(missing_ok=True)
        for src, dest in moves:
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(src, dest)
        os.replace(db, db_target)
        reconciled = _reconcile(db_target, data_dir)

        env = out / "deploy.env"
        if env.is_file():
            target_env = data_dir / RESTORED_ENV
            os.replace(env, target_env)
            os.chmod(target_env, 0o600)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    return {
        "createdAt": manifest["createdAt"],
        "version": manifest.get("version"),
        "schema": manifest["schema"],
        "counts": manifest["counts"],
        "files": len(manifest["files"]),
        **reconciled,
    }


def verify_backup(archive: Path, identity: str) -> dict[str, Any]:
    """恢复演练：解密并完整恢复到临时目录，核对所有校验值，不碰现有数据。"""
    with tempfile.TemporaryDirectory(prefix="minddock-verify-") as tmp:
        return restore_backup(archive, identity, Path(tmp))
