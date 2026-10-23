"""SQLite 连接与编号迁移。

迁移文件位于 migrations/，命名为 NNNN_说明.sql；已应用的最大编号记在 PRAGMA user_version。
"""

import re
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
_MIGRATION_NAME = re.compile(r"^(\d{4})_[\w-]+\.sql$")


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None：自动提交，事务由调用方显式 BEGIN / COMMIT
    conn = sqlite3.connect(path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _migrations() -> list[tuple[int, Path]]:
    found = []
    for path in MIGRATIONS_DIR.iterdir():
        match = _MIGRATION_NAME.match(path.name)
        if match:
            found.append((int(match.group(1)), path))
    found.sort()
    numbers = [n for n, _ in found]
    if numbers != list(range(1, len(numbers) + 1)):
        raise RuntimeError(f"迁移编号必须从 0001 起连续：{numbers}")
    return found


def migrate(conn: sqlite3.Connection) -> int:
    """应用尚未执行的迁移，返回迁移后的版本号。"""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    for number, path in _migrations():
        if number <= current:
            continue
        sql = path.read_text(encoding="utf-8")
        # executescript 会先提交未完成的事务，所以把版本号写在同一个脚本事务里
        conn.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
        current = number
    return current


def latest_version() -> int:
    return _migrations()[-1][0]


async def wait_for_schema(conn: sqlite3.Connection, timeout: float = 120) -> None:
    """bot / worker 不自己迁移，等面板把数据库迁移到最新版本，避免多进程同时迁移。"""
    import asyncio

    target, waited = latest_version(), 0.0
    while conn.execute("PRAGMA user_version").fetchone()[0] < target:
        if waited >= timeout:
            raise RuntimeError(f"等待数据库迁移到版本 {target} 超时，请确认面板服务已启动")
        await asyncio.sleep(1)
        waited += 1


def now_iso(offset_seconds: int = 0) -> str:
    """UTC 时间，ISO 8601，秒级精度，例如 2026-10-23T07:30:12Z。同格式的字符串可以直接比较大小。"""
    moment = datetime.now(UTC) + timedelta(seconds=offset_seconds)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")
