"""原件归档：远端命名、上传与核对、跳过已存在、失败告警与恢复、设置变更后补传、任务筛选、接口。"""

import asyncio

import pytest
from conftest import setup_account

from minddock import storage
from minddock.bot import OWNER_KEY
from minddock.config import Settings
from minddock.db import connect, migrate, now_iso
from minddock.ingest import Incoming, IncomingAttachment, ingest
from minddock.integrations.openlist import OpenListError
from minddock.jobs import claim, enqueue
from minddock.security import Cipher
from minddock.settings_store import SettingsStore
from minddock.util import kv_set

TZ = "Asia/Shanghai"


class FakeOpenList:
    def __init__(self):
        self.files: dict[str, int] = {}
        self.puts: list[str] = []
        self.fail: str | None = None
        self.truncate = False

    async def ensure_login(self):
        pass

    async def mkdir(self, path):
        if self.fail:
            raise OpenListError(self.fail)

    async def list_dir(self, path):
        return [
            {"name": p.rsplit("/", 1)[1], "size": size}
            for p, size in self.files.items()
            if p.rsplit("/", 1)[0] == path
        ]

    async def put_file(self, path, local, size):
        self.puts.append(path)
        self.files[path] = size - 1 if self.truncate else local.stat().st_size


class FakeNotifier:
    def __init__(self):
        self.sent: list[str] = []

    async def send(self, text, **kwargs):
        self.sent.append(text)


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    migrate(c)
    kv_set(c, OWNER_KEY, {"openid": "me", "bound_at": now_iso()})
    return c


@pytest.fixture
def archiver(conn, tmp_path):
    store = SettingsStore(conn, Cipher(b"k" * 32))
    store.update("storage", {"quark_cookie": "c", "folder": "MindDock"})
    a = storage.Archiver(
        conn, store, None, Settings(data_dir=tmp_path / "data", tz=TZ), FakeNotifier()
    )
    a.fake = FakeOpenList()

    async def client():
        return a.fake

    a.client = client
    return a


def downloaded_file(conn, data_dir, name="照片.jpg", content=b"JPEGDATA", msg_id="m1") -> str:
    att = IncomingAttachment(url="https://q.example/a", filename=name, content_type="image/jpeg")
    item_id = ingest(
        conn, Incoming(msg_id=msg_id, openid="me", content="", attachments=[att])
    ).item_id
    file_id = conn.execute("SELECT id FROM files WHERE item_id = ?", (item_id,)).fetchone()[0]
    relative = f"staging/2026/10/{file_id}.jpg"
    (data_dir / relative).parent.mkdir(parents=True, exist_ok=True)
    (data_dir / relative).write_bytes(content)
    conn.execute(
        "UPDATE files SET local_path = ?, size = ?, created_at = '2026-10-23T07:30:12Z' WHERE id = ?",
        (relative, len(content), file_id),
    )
    return file_id


def file_row(conn, file_id):
    return conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()


def test_remote_path_is_readable_and_safe(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir, name="合同:最终版?.pdf")
    row = conn.execute(
        "SELECT f.*, i.short_code FROM files f JOIN items i ON i.id = f.item_id WHERE f.id = ?",
        (file_id,),
    ).fetchone()
    path = storage.remote_path("MindDock", row, "A3F9", TZ)
    assert path == "/quark/MindDock/originals/2026/10/20261023-153012_A3F9_合同_最终版_.pdf"
    conn.execute("UPDATE files SET original_name = NULL WHERE id = ?", (file_id,))
    row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    assert storage.remote_path("M", row, "A3F9", TZ).endswith("_A3F9_image.jpg")


def test_upload_marks_uploaded_after_size_check(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    asyncio.run(archiver.upload(file_id))
    row = file_row(conn, file_id)
    assert (row["upload_status"], row["backend"]) == ("uploaded", "quark")
    assert row["remote_path"] in archiver.fake.files and row["uploaded_at"]
    assert (archiver.config.data_dir / row["local_path"]).exists()  # 本地原件先保留

    # 远端已有同样大小的文件（上次传完没来得及记录）：不再重复上传
    other = downloaded_file(conn, archiver.config.data_dir, msg_id="m2")
    row = conn.execute(
        "SELECT f.*, i.short_code FROM files f JOIN items i ON i.id = f.item_id WHERE f.id = ?",
        (other,),
    ).fetchone()
    archiver.fake.files[storage.remote_path("MindDock", row, row["short_code"], TZ)] = 8
    asyncio.run(archiver.upload(other))
    assert file_row(conn, other)["upload_status"] == "uploaded"
    assert len(archiver.fake.puts) == 1


def test_size_mismatch_is_a_failure(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    archiver.fake.truncate = True
    with pytest.raises(storage.StorageError, match="大小一致"):
        asyncio.run(archiver.upload(file_id))
    assert file_row(conn, file_id)["upload_status"] == "failed"


def test_repeated_failures_alert_once_and_recover(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    archiver.fake.fail = "require login [quark]"
    for _ in range(4):
        with pytest.raises(OpenListError):
            asyncio.run(archiver.upload(file_id))
    state = storage.health(conn)
    assert state["state"] == "error" and state["failures"] == 4
    assert len(archiver.notifier.sent) == 1 and "Cookie" in archiver.notifier.sent[0]

    archiver.fake.fail = None
    asyncio.run(archiver.upload(file_id))
    assert storage.health(conn) == {"state": "ok", "failures": 0}


def test_new_settings_requeue_failed_uploads(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    conn.execute("UPDATE files SET upload_status = 'failed' WHERE id = ?", (file_id,))
    kv_set(conn, storage.HEALTH_KEY, {"state": "error", "failures": 5})
    archiver.watch_settings()  # 设置没变：不动
    assert file_row(conn, file_id)["upload_status"] == "failed"

    archiver.store.update("storage", {"quark_cookie": "new"})
    archiver.watch_settings()
    assert file_row(conn, file_id)["upload_status"] == "pending"
    assert storage.health(conn)["state"] == "ok"
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE type = 'upload' AND ref_id = ? AND status = 'queued'",
            (file_id,),
        ).fetchone()[0]
        == 1
    )


def test_enqueue_pending_and_claim_filters(conn, archiver):
    ready = downloaded_file(conn, archiver.config.data_dir)
    att = IncomingAttachment(url="https://q.example/b", filename="b.jpg", content_type="image/jpeg")
    ingest(conn, Incoming(msg_id="m9", openid="me", content="", attachments=[att]))  # 还没下载
    assert storage.enqueue_pending(conn) == 1
    assert storage.enqueue_pending(conn) == 0  # 已有排队中的任务

    enqueue(conn, "organize", "x")
    assert claim(conn, only=("upload",)).ref_id == ready
    assert claim(conn, exclude=("upload",)).type in ("download", "organize")


def test_storage_api(client, app):
    setup_account(client, app)
    db = app.state.db
    file_id = downloaded_file(db, app.state.config.data_dir)
    db.execute("UPDATE files SET upload_status = 'failed' WHERE id = ?", (file_id,))

    state = client.get("/api/storage").json()
    assert state["configured"] is False and state["counts"]["failed"] == 1
    assert state["localFiles"] == 1 and state["keepDays"] == 7

    item = client.post(f"/api/files/{file_id}/upload").json()
    assert item["attachments"][0]["uploadStatus"] == "pending"
    assert client.post("/api/files/nope/upload").status_code == 404
    db.execute("UPDATE files SET upload_status = 'failed' WHERE id = ?", (file_id,))
    assert client.post("/api/storage/retry").json()["requeued"] >= 1
