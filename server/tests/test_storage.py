"""原件归档：远端命名、上传与核对、跳过已存在、失败告警与恢复、设置变更后补传、任务筛选、接口。"""

import asyncio

import pytest
from conftest import setup_account

from minddock import storage
from minddock.bot import OWNER_KEY
from minddock.config import Settings
from minddock.db import connect, migrate, now_iso
from minddock.ingest import Incoming, IncomingAttachment, ingest
from minddock.integrations.openlist import QUARK_LOGGED_OUT, OpenListError
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
        if self.fail:
            raise OpenListError(self.fail)
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
    store.update("storage", {"quark_cookie": "__pus=c", "folder": "MindDock"})
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
    archiver.fake.fail = "无法连接 OpenList：timed out"
    for _ in range(2):
        with pytest.raises(OpenListError):
            asyncio.run(archiver.upload(file_id))
    assert storage.health(conn)["state"] == "ok" and not archiver.notifier.sent  # 偶发问题不打扰
    for _ in range(2):
        with pytest.raises(OpenListError):
            asyncio.run(archiver.upload(file_id))
    state = storage.health(conn)
    assert state["state"] == "error" and state["failures"] == 4
    assert len(archiver.notifier.sent) == 1 and "连续 3 次" in archiver.notifier.sent[0]

    archiver.fake.fail = None
    asyncio.run(archiver.upload(file_id))
    assert storage.health(conn) == {"state": "ok", "failures": 0}
    assert storage.verified(conn)["ok"]


def test_logged_out_cookie_alerts_immediately(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    archiver.fake.fail = "failed to make dir: require login [guest]"
    with pytest.raises(OpenListError):
        asyncio.run(archiver.upload(file_id))
    state = storage.health(conn)
    assert (state["state"], state["reason"], state["error"]) == ("error", "login", QUARK_LOGGED_OUT)
    assert len(archiver.notifier.sent) == 1 and "登录已失效" in archiver.notifier.sent[0]


def test_login_check_runs_when_quark_has_been_quiet(conn, archiver):
    assert storage.check_due(conn)  # 从没检查过
    asyncio.run(archiver.check_if_due())
    assert storage.verified(conn)["ok"] and not storage.check_due(conn)

    # 6 小时内和夸克打过交道（例如上传成功）就不用再检查
    kv_set(conn, storage.VERIFIED_KEY, {"at": now_iso(-5 * 3600), "ok": True})
    assert not storage.check_due(conn)
    kv_set(conn, storage.VERIFIED_KEY, {"at": now_iso(-7 * 3600), "ok": True})
    assert storage.check_due(conn)

    # Cookie 失效：立即告警；之后每小时再查一次，重复失败不重复告警
    archiver.fake.fail = "require login [guest]"
    assert asyncio.run(archiver.check_login()) is False
    assert storage.health(conn)["reason"] == "login" and len(archiver.notifier.sent) == 1
    assert not storage.check_due(conn)
    kv_set(conn, storage.VERIFIED_KEY, {"at": now_iso(-3601), "ok": False})
    asyncio.run(archiver.check_if_due())
    assert storage.health(conn)["failures"] == 2 and len(archiver.notifier.sent) == 1

    archiver.fake.fail = None
    assert asyncio.run(archiver.check_login()) is True
    assert storage.health(conn) == {"state": "ok", "failures": 0}


def test_login_check_does_not_hide_upload_problems(conn, archiver):
    problem = {"state": "error", "failures": 3, "error": "空间不足", "reason": "error"}
    kv_set(conn, storage.HEALTH_KEY, {**problem, "source": "upload"})
    asyncio.run(archiver.check_login())
    assert storage.health(conn)["state"] == "error"  # 要等上传成功才算恢复


def test_new_settings_requeue_failed_uploads(conn, archiver):
    file_id = downloaded_file(conn, archiver.config.data_dir)
    conn.execute("UPDATE files SET upload_status = 'failed' WHERE id = ?", (file_id,))
    kv_set(conn, storage.HEALTH_KEY, {"state": "error", "failures": 5})
    archiver.watch_settings()  # 设置没变：不动
    assert file_row(conn, file_id)["upload_status"] == "failed"

    archiver.store.update("storage", {"quark_cookie": "__pus=new"})
    archiver.watch_settings()
    assert storage.check_due(conn)  # 换了 Cookie：下次例行维护立即检查
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
    assert state["localFiles"] == 1 and state["keepDays"] == 7 and state["lastCheck"] is None

    item = client.post(f"/api/files/{file_id}/upload").json()
    assert item["attachments"][0]["uploadStatus"] == "pending"
    assert client.post("/api/files/nope/upload").status_code == 404
    db.execute("UPDATE files SET upload_status = 'failed' WHERE id = ?", (file_id,))
    assert client.post("/api/storage/retry").json()["requeued"] >= 1


# ---- 缩略图 ----


def test_thumbnails_are_small_webp(tmp_path):
    from PIL import Image

    from minddock.thumbs import ThumbnailError, make_thumbnail

    src = tmp_path / "big.jpg"
    Image.new("RGB", (2000, 1000), "orange").save(src)
    make_thumbnail(src, tmp_path / "t" / "big.webp")
    with Image.open(tmp_path / "t" / "big.webp") as thumb:
        assert thumb.format == "WEBP" and thumb.size == (480, 240)

    png = tmp_path / "alpha.png"
    Image.new("RGBA", (100, 100), (0, 0, 0, 0)).save(png)
    make_thumbnail(png, tmp_path / "alpha.webp")  # 小图不放大，保留透明
    with Image.open(tmp_path / "alpha.webp") as thumb:
        assert thumb.size == (100, 100) and thumb.mode == "RGBA"

    bad = tmp_path / "bad.jpg"
    bad.write_bytes(b"not an image")
    with pytest.raises(ThumbnailError):
        make_thumbnail(bad, tmp_path / "bad.webp")


def test_worker_generates_thumbnail_once(conn, archiver):
    from PIL import Image

    from minddock.worker import Worker, enqueue_missing_thumbnails, handle_thumbnail

    file_id = downloaded_file(conn, archiver.config.data_dir)
    local = archiver.config.data_dir / file_row(conn, file_id)["local_path"]
    Image.new("RGB", (800, 600), "teal").save(local, "JPEG")
    worker = Worker(conn, archiver.store, None, archiver.config)

    assert enqueue_missing_thumbnails(conn) == 1
    asyncio.run(handle_thumbnail(worker, file_id))
    row = file_row(conn, file_id)
    assert row["thumb_path"].endswith(f"{file_id}.webp")
    assert (archiver.config.data_dir / row["thumb_path"]).is_file()
    assert enqueue_missing_thumbnails(conn) == 0


# ---- 本地清理 ----


class FakeDisk:
    def __init__(self, conn):
        self.conn = conn

    def __call__(self, path):
        # 每个本地文件占 10%，总量 100
        used = self.conn.execute(
            "SELECT COUNT(*) FROM files WHERE local_path IS NOT NULL"
        ).fetchone()[0]
        return type("Usage", (), {"total": 100, "free": 100 - used * 10 - 55})()


def test_cleanup_only_removes_confirmed_uploads(conn, archiver):
    data_dir = archiver.config.data_dir
    old = downloaded_file(conn, data_dir, msg_id="a")
    recent = downloaded_file(conn, data_dir, msg_id="b")
    newest = downloaded_file(conn, data_dir, msg_id="c")
    pending = downloaded_file(conn, data_dir, msg_id="d")
    for file_id, age in ((old, 8 * 86400), (recent, 3 * 86400), (newest, 60)):
        conn.execute(
            "UPDATE files SET upload_status = 'uploaded', uploaded_at = ? WHERE id = ?",
            (now_iso(-age), file_id),
        )
    old_path = data_dir / file_row(conn, old)["local_path"]

    # 磁盘宽裕：只清理超过 7 天的
    roomy = lambda path: type("Usage", (), {"total": 100, "free": 90})()  # noqa: E731
    assert storage.cleanup_local(conn, data_dir, 7, 0.2, roomy) == 1
    assert not old_path.exists() and file_row(conn, old)["local_path"] is None

    # 磁盘紧张：从最旧的已上传文件开始清理，直到空间够用；未上传的绝不删除
    assert storage.cleanup_local(conn, data_dir, 7, 0.2, FakeDisk(conn)) == 1
    assert file_row(conn, recent)["local_path"] is None
    assert file_row(conn, newest)["local_path"] is not None
    assert file_row(conn, pending)["local_path"] is not None


# ---- 下载 ----


def test_download_falls_back_to_quark_and_thumbs_are_served(client, app):
    import httpx2

    setup_account(client, app)
    db, data_dir = app.state.db, app.state.config.data_dir
    file_id = downloaded_file(db, data_dir)
    db.execute(
        "UPDATE files SET local_path = NULL, upload_status = 'uploaded', remote_path = ? WHERE id = ?",
        ("/quark/MindDock/originals/2026/10/x.jpg", file_id),
    )

    def openlist(req: httpx2.Request) -> httpx2.Response:
        if req.url.path == "/api/auth/login":
            return httpx2.Response(200, json={"code": 200, "data": {"token": "t"}})
        if req.url.path == "/api/fs/get":
            raw = "http://openlist:5244/p/quark/x.jpg?sign=s"
            return httpx2.Response(200, json={"code": 200, "data": {"raw_url": raw}})
        assert req.headers["range"] == "bytes=0-3"
        return httpx2.Response(206, content=b"JPEG", headers={"content-range": "bytes 0-3/8"})

    app.state.config.openlist_admin_password = "pw"
    app.state.http = httpx2.AsyncClient(transport=httpx2.MockTransport(openlist))
    item = client.get(f"/api/items/{db.execute('SELECT item_id FROM files').fetchone()[0]}").json()
    assert item["attachments"][0]["downloadUrl"] == f"/api/files/{file_id}/raw?download=1"

    resp = client.get(f"/api/files/{file_id}/raw?download=1", headers={"Range": "bytes=0-3"})
    assert resp.status_code == 206 and resp.content == b"JPEG"
    assert resp.headers["content-range"] == "bytes 0-3/8"
    assert resp.headers["content-disposition"].startswith("attachment;")

    assert client.get(f"/api/files/{file_id}/thumb").status_code == 404
    thumb = data_dir / "thumbs" / "t.webp"
    thumb.parent.mkdir(parents=True)
    thumb.write_bytes(b"RIFF")
    db.execute("UPDATE files SET thumb_path = 'thumbs/t.webp' WHERE id = ?", (file_id,))
    resp = client.get(f"/api/files/{file_id}/thumb")
    assert resp.status_code == 200 and "immutable" in resp.headers["cache-control"]
