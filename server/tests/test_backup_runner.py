"""每日备份：何时该做、远端保留规则、生成并上传、失败只告警一次、面板接口。"""

import asyncio
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from conftest import setup_account
from test_storage import FakeNotifier, FakeOpenList

from minddock import backup, backup_runner, storage
from minddock.config import Settings
from minddock.db import connect, migrate
from minddock.security import Cipher
from minddock.settings_store import SettingsStore

TZ = "Asia/Shanghai"


def at(local: str) -> datetime:
    """上海时间的某一刻，换成 UTC。"""
    return datetime.fromisoformat(f"{local}+08:00").astimezone(UTC)


def test_due_schedule(tmp_path):
    conn = connect(tmp_path / "t.db")
    migrate(conn)
    off = Settings(data_dir=tmp_path, tz=TZ)
    on = Settings(data_dir=tmp_path, tz=TZ, backup_recipient="age1x")
    assert not backup_runner.due(conn, off, at("2026-10-25T03:20:00"))
    # 从没备份过：立即做，不等到凌晨
    assert backup_runner.due(conn, on, at("2026-10-25T14:00:00"))

    backup.record(conn, last={"createdAt": "2026-10-25T03:16:00+08:00"})
    assert not backup_runner.due(conn, on, at("2026-10-25T23:59:00"))
    assert not backup_runner.due(conn, on, at("2026-10-26T03:00:00"))
    assert backup_runner.due(conn, on, at("2026-10-26T03:20:00"))

    # 失败后一小时内不重试
    now = at("2026-10-26T03:30:00")
    backup.record(conn, failedAt=(now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"))
    assert not backup_runner.due(conn, on, now)
    assert backup_runner.due(conn, on, now + timedelta(hours=1))


def test_remote_retention_keeps_recent_and_monthly():
    start = datetime(2025, 9, 1)
    names = [f"minddock-{start + timedelta(days=d):%Y%m%d}-031500.tar.gz.age" for d in range(420)]
    names.append("not-a-backup.txt")
    stale = backup_runner.to_prune(names)
    kept = sorted(set(n for n in names if n.startswith("minddock-")) - set(stale), reverse=True)
    assert kept[:30] == sorted(names[-31:-1], reverse=True)  # 最近 30 份
    months = {n[9:15] for n in kept}
    # 10 月与 9 月最新的一份已在最近 30 份里，另加 8 月到去年 11 月每月一份
    assert len(months) == 12 and len(kept) == 30 + 10
    assert "not-a-backup.txt" not in stale


def make_worker(tmp_path, *, recipient: str, storage_configured: bool):
    config = Settings(data_dir=tmp_path / "data", tz=TZ, backup_recipient=recipient)
    conn = connect(config.db_path)
    migrate(conn)
    store = SettingsStore(conn, Cipher(b"k" * 32))
    if storage_configured:
        store.update("storage", {"quark_cookie": "__pus=c", "folder": "MindDock"})
    notifier = FakeNotifier()
    archiver = storage.Archiver(conn, store, None, config, notifier)
    fake = FakeOpenList()
    fake.removed = []

    async def remove(parent, names):
        fake.removed += names
        for n in names:
            fake.files.pop(f"{parent}/{n}", None)

    async def client():
        return fake

    fake.remove = remove
    archiver.client = client
    worker = SimpleNamespace(
        conn=conn, config=config, store=store, notifier=notifier, archiver=archiver
    )
    return worker, fake


def test_run_creates_uploads_and_prunes(tmp_path):
    public, _ = backup.generate_keypair()
    worker, fake = make_worker(tmp_path, recipient=public, storage_configured=True)
    folder = "/quark/MindDock/backups"
    for m in range(24):  # 2024-01 到 2025-12 每月一份
        fake.files[f"{folder}/minddock-{2024 + m // 12}{m % 12 + 1:02d}15-031500.tar.gz.age"] = 1
    for d in range(1, 21):
        fake.files[f"{folder}/minddock-202610{d:02d}-031500.tar.gz.age"] = 1

    result = asyncio.run(backup_runner.run(worker))
    assert result is not None
    state = backup.status(worker.conn)
    assert state["ok"] is True and state["last"]["name"] == result["name"]
    assert state["remote"]["ok"] is True
    assert fake.puts == [f"/quark/MindDock/backups/{result['name']}"]
    # 每月一份只留有备份的最近 12 个月：本月 + 2025-02 到 2025-12
    assert "minddock-20240115-031500.tar.gz.age" in fake.removed
    assert "minddock-20250115-031500.tar.gz.age" in fake.removed
    assert "minddock-20250215-031500.tar.gz.age" not in fake.removed
    assert len(fake.removed) == 13


def test_failure_alerts_once_and_upload_failure_is_recorded(tmp_path):
    worker, _ = make_worker(tmp_path, recipient="not-a-key", storage_configured=False)
    assert asyncio.run(backup_runner.run(worker)) is None
    assert asyncio.run(backup_runner.run(worker)) is None
    state = backup.status(worker.conn)
    assert state["ok"] is False and "age1" in state["error"]
    assert len(worker.notifier.sent) == 1

    public, _ = backup.generate_keypair()
    worker, fake = make_worker(tmp_path / "b", recipient=public, storage_configured=True)
    fake.fail = "network down"
    assert asyncio.run(backup_runner.run(worker)) is not None  # 本地备份照样成功
    state = backup.status(worker.conn)
    assert state["ok"] is True and state["remote"] == {**state["remote"], "ok": False}
    assert "network down" in state["remote"]["error"]


def test_backups_api(client, app):
    setup_account(client, app)
    state = client.get("/api/backups").json()
    assert state["configured"] is False and state["local"] == []
    assert client.post("/api/backups").status_code == 409

    app.state.config.backup_recipient = backup.generate_keypair()[0]
    assert client.post("/api/backups").json() == {"queued": True}
    assert client.get("/api/backups").json()["running"] is True
    job = app.state.db.execute("SELECT type, ref_id FROM jobs WHERE type = 'backup'").fetchone()
    assert tuple(job) == ("backup", "manual")

    folder = app.state.config.data_dir / backup.BACKUP_DIR
    folder.mkdir(parents=True)
    (folder / "minddock-20261025-031500.tar.gz.age").write_bytes(b"sealed")
    assert client.get("/api/backups").json()["local"][0]["size"] == 6
    resp = client.get("/api/backups/minddock-20261025-031500.tar.gz.age")
    assert resp.status_code == 200 and resp.content == b"sealed"
    assert client.get("/api/backups/..%2Fminddock.db").status_code == 404
    logged = app.state.db.execute(
        "SELECT action FROM audit_log WHERE action = 'backup_download'"
    ).fetchone()
    assert logged is not None
