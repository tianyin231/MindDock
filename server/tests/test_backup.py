"""加密备份与恢复：往返一致、标准 age 格式、私钥不对、已有数据、版本过新、恶意内容、本地保留份数。"""

import io
import json
import tarfile
from datetime import datetime
from pathlib import Path

import pyrage
import pytest
from nacl.public import PrivateKey
from pyrage import x25519

from minddock import backup, vault
from minddock.config import Settings
from minddock.db import connect, migrate
from minddock.ingest import Incoming, IncomingAttachment, ingest


@pytest.fixture
def keys():
    return backup.generate_keypair()


def make_config(tmp_path: Path, recipient: str) -> Settings:
    return Settings(data_dir=tmp_path / "old", backup_recipient=recipient, secret_key="")


def write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def populate(config: Settings):
    conn = connect(config.db_path)
    migrate(conn)
    ingest(conn, Incoming(msg_id="m1", openid="me", content="周末去爬山"))
    ingest(
        conn,
        Incoming(
            msg_id="m2",
            openid="me",
            content="",
            attachments=[
                IncomingAttachment(
                    url="http://x/a.jpg", filename="a.jpg", content_type="image/jpeg"
                ),
                IncomingAttachment(
                    url="http://x/b.pdf", filename="b.pdf", content_type="application/pdf"
                ),
            ],
        ),
    )
    rows = {
        r["original_name"]: r["id"] for r in conn.execute("SELECT id, original_name FROM files")
    }
    data = config.data_dir
    # a.jpg 已上传夸克（本地还留着，但不进备份），有缩略图；b.pdf 还没上传，必须进备份
    write(data / "staging/2026/10/a.jpg", b"jpeg-bytes")
    write(data / "thumbs/2026/10/a.webp", b"webp-bytes")
    write(data / "staging/2026/10/b.pdf", b"pdf-bytes")
    conn.execute(
        "UPDATE files SET local_path = ?, thumb_path = ?, upload_status = 'uploaded' WHERE id = ?",
        ("staging/2026/10/a.jpg", "thumbs/2026/10/a.webp", rows["a.jpg"]),
    )
    conn.execute(
        "UPDATE files SET local_path = ? WHERE id = ?", ("staging/2026/10/b.pdf", rows["b.pdf"])
    )
    pk = bytes(PrivateKey.generate().public_key)
    secret = vault.store_file(
        conn, data, pk, "身份证照片", b"photo", original_name="id.jpg", mime="image/jpeg"
    )
    return conn, rows, secret


def test_backup_and_restore_round_trip(tmp_path, keys, monkeypatch):
    public, secret_key = keys
    monkeypatch.setenv("MINDDOCK_SECRET_KEY", "main-key")
    monkeypatch.setenv("MINDDOCK_DOMAIN", "old.example.com")
    config = make_config(tmp_path, public)
    conn, rows, secret = populate(config)

    result = backup.create_backup(conn, config)
    assert result["counts"] == {"items": 2, "secrets": 1, "files": 2}
    assert result["files"] == 3 and result["missing"] == 0  # pdf、缩略图、密钥密文
    archive = config.data_dir / "backups" / result["name"]

    # 标准 age 格式：不经过 MindDock 也能解开
    plain = pyrage.decrypt(archive.read_bytes(), [x25519.Identity.from_str(secret_key)])
    with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
        names = tar.getnames()
    assert {"manifest.json", "deploy.env", "minddock.db"} <= set(names)
    assert "data/staging/2026/10/b.pdf" in names
    assert not any(n.endswith("a.jpg") for n in names)

    target = tmp_path / "new"
    summary = backup.restore_backup(archive, f"# comment\n{secret_key}\n", target)
    assert summary["remote"] == 1 and summary["lost"] == 0 and summary["thumbs"] == 0

    restored = connect(target / "minddock.db")
    assert restored.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 2
    jpg = restored.execute("SELECT * FROM files WHERE id = ?", (rows["a.jpg"],)).fetchone()
    assert jpg["local_path"] is None and jpg["thumb_path"] == "thumbs/2026/10/a.webp"
    assert (target / "staging/2026/10/b.pdf").read_bytes() == b"pdf-bytes"
    assert (target / "thumbs/2026/10/a.webp").read_bytes() == b"webp-bytes"
    blob = restored.execute("SELECT blob_path FROM secrets").fetchone()[0]
    assert (target / blob).read_bytes() == (config.data_dir / blob).read_bytes()

    env = (target / backup.RESTORED_ENV).read_text()
    assert "MINDDOCK_SECRET_KEY=main-key" in env and "MINDDOCK_DOMAIN=old.example.com" in env
    assert not any(p.name.startswith(".restore-") for p in target.iterdir())


def test_restore_rejects_wrong_key_and_existing_data(tmp_path, keys):
    public, secret_key = keys
    config = make_config(tmp_path, public)
    conn, _, _ = populate(config)
    archive = config.data_dir / "backups" / backup.create_backup(conn, config)["name"]

    other = backup.generate_keypair()[1]
    with pytest.raises(backup.RestoreError, match="解密失败"):
        backup.restore_backup(archive, other, tmp_path / "new")
    with pytest.raises(backup.RestoreError, match="私钥"):
        backup.restore_backup(archive, "not a key", tmp_path / "new")

    # 目标已有数据库时默认拒绝，--force 才覆盖（恢复时服务都已停止，这里也先关掉连接）
    with pytest.raises(backup.RestoreError, match="已存在"):
        backup.restore_backup(archive, secret_key, config.data_dir)
    conn.close()
    assert backup.restore_backup(archive, secret_key, config.data_dir, force=True)["files"] == 3


def test_restore_refuses_backup_from_newer_schema(tmp_path, keys, monkeypatch):
    public, secret_key = keys
    config = make_config(tmp_path, public)
    conn, _, _ = populate(config)
    archive = config.data_dir / "backups" / backup.create_backup(conn, config)["name"]
    monkeypatch.setattr(backup, "latest_version", lambda: 1)
    with pytest.raises(backup.RestoreError, match="更新的版本"):
        backup.restore_backup(archive, secret_key, tmp_path / "new")
    assert not (tmp_path / "new" / "minddock.db").exists()


def test_restore_rejects_unexpected_members(tmp_path, keys):
    # 公钥不是秘密，任何人都能做出"合法加密"的包，所以内容本身也要检查
    public, secret_key = keys
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("../evil.txt")
        info.size = 4
        tar.addfile(info, io.BytesIO(b"evil"))
    archive = tmp_path / "evil.tar.gz.age"
    archive.write_bytes(pyrage.encrypt(buf.getvalue(), [x25519.Recipient.from_str(public)]))
    with pytest.raises(backup.RestoreError, match="意外的内容"):
        backup.restore_backup(archive, secret_key, tmp_path / "new")
    assert not (tmp_path / "evil.txt").exists()

    manifest = {
        "format": 1,
        "createdAt": "x",
        "schema": 1,
        "counts": {},
        "database": {"sha256": "0"},
        "files": [{"path": "../../outside", "sha256": "0", "size": 0}],
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = json.dumps(manifest).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    archive.write_bytes(pyrage.encrypt(buf.getvalue(), [x25519.Recipient.from_str(public)]))
    with pytest.raises(backup.RestoreError, match="校验失败"):
        backup.restore_backup(archive, secret_key, tmp_path / "new")


def test_backup_requires_recipient_and_keeps_recent_copies(tmp_path, keys):
    config = make_config(tmp_path, "")
    conn, _, _ = populate(config)
    with pytest.raises(backup.BackupError, match="MINDDOCK_BACKUP_RECIPIENT"):
        backup.create_backup(conn, config)

    config = Settings(data_dir=config.data_dir, backup_recipient=keys[0], backup_keep_local=2)
    for day in (1, 2, 3):
        backup.create_backup(conn, config, now=datetime(2026, 10, day, 3, 15))
    assert [b["name"] for b in backup.list_local(config.data_dir)] == [
        "minddock-20261003-031500.tar.gz.age",
        "minddock-20261002-031500.tar.gz.age",
    ]
    assert backup.local_path(config.data_dir, "../minddock.db") is None
