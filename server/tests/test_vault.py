"""密钥库：消息拆分、机器人加密入库（文字与附件）、明文不落盘、接口与持有私钥的验证。"""

import asyncio
import base64
import os

import httpx2
import pytest
from conftest import setup_account
from nacl.public import PrivateKey, SealedBox

from minddock import vault
from minddock.bot import OWNER_KEY, Bot
from minddock.config import Settings
from minddock.db import connect, migrate, now_iso
from minddock.ingest import Incoming, IncomingAttachment
from minddock.security import Cipher
from minddock.settings_store import SettingsStore
from minddock.util import kv_set

PARAMS = {"alg": "argon2id13", "ops": 3, "mem": 64 << 20}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def fake_wrap() -> vault.Wrap:
    # 服务器不解包，只核对长度和参数；测试里用随机字节代替真正的包裹结果
    return vault.Wrap(os.urandom(vault.WRAPPED_LEN), os.urandom(vault.SALT_LEN), PARAMS)


def opened(sk: PrivateKey, sealed: bytes) -> bytes:
    return SealedBox(sk).decrypt(sealed)


@pytest.mark.parametrize(
    ("text", "attachments", "detected", "expected"),
    [
        ("#key 路由器密码\nabc 123\n第二行", False, None, ("路由器密码", "abc 123\n第二行")),
        ("#key 路由器密码 abc123", False, None, ("路由器密码", "abc123")),
        ("#key abc123", False, None, ("未命名密钥", "abc123")),
        ("#key 身份证", True, None, ("身份证", "")),
        (
            "token: sk-proj-abcdefghijklmnopqrstuvwx",
            False,
            "包含 API Key",
            ("API Key", "token: sk-proj-abcdefghijklmnopqrstuvwx"),
        ),
    ],
)
def test_split_message(text, attachments, detected, expected):
    assert vault.split_message(text, attachments, detected) == expected


# ---- 机器人 ----


class FakeQQ:
    def __init__(self):
        self.sent: list[str] = []

    async def send_c2c(self, openid, content, msg_id=None, msg_seq=1):
        self.sent.append(content)
        return {}


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    migrate(c)
    kv_set(c, OWNER_KEY, {"openid": "me", "bound_at": now_iso()})
    return c


@pytest.fixture
def bot(conn, tmp_path):
    b = Bot(
        conn, SettingsStore(conn, Cipher(b"k" * 32)), None, Settings(data_dir=tmp_path / "data")
    )
    b.api = FakeQQ()
    return b


def enable_vault(conn) -> PrivateKey:
    sk = PrivateKey.generate()
    vault.setup(conn, bytes(sk.public_key), fake_wrap(), fake_wrap())
    return sk


def send(bot, text, msg_id="m1", attachments=None):
    msg = Incoming(msg_id=msg_id, openid="me", content=text, attachments=attachments or [])
    asyncio.run(bot.on_c2c(msg))
    return bot.api.sent[-1]


def test_secret_not_saved_before_vault_is_enabled(bot, conn):
    assert "密钥库还没启用" in send(bot, "#key 路由器密码\nabc123")
    assert conn.execute("SELECT COUNT(*) FROM secrets").fetchone()[0] == 0


def test_explicit_and_detected_secrets_are_sealed(bot, conn):
    sk = enable_vault(conn)
    reply = send(bot, "#key 路由器密码\nabc123")
    row = conn.execute("SELECT * FROM secrets").fetchone()
    assert f"#{row['short_code']}" in reply and "撤回" in reply
    assert (row["label"], row["kind"], row["detected"]) == ("路由器密码", "text", None)
    assert opened(sk, row["sealed"]) == b"abc123"
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 0  # 不进普通条目

    count = len(bot.api.sent)
    send(bot, "#key 路由器密码\nabc123")  # 同一条消息重复投递
    assert len(bot.api.sent) == count

    reply = send(bot, "这是 key：sk-proj-abcdefghijklmnopqrstuvwx", msg_id="m2")
    assert "自动识别" in reply
    row = conn.execute("SELECT * FROM secrets WHERE source_msg_id = 'm2'").fetchone()
    assert row["label"] == "API Key" and row["detected"] == "包含 API Key"
    assert (
        conn.execute("SELECT COUNT(*) FROM events WHERE type = 'secret.stored'").fetchone()[0] == 2
    )


def test_secret_attachments_never_touch_disk_in_plaintext(bot, conn, tmp_path):
    sk = enable_vault(conn)
    image = b"\xff\xd8\xff" + b"ID-CARD-PIXELS" * 1000
    bot.http = httpx2.AsyncClient(
        transport=httpx2.MockTransport(lambda req: httpx2.Response(200, content=image))
    )
    atts = [
        IncomingAttachment(url="https://q.example/a", filename="id.jpg", content_type="image/jpeg"),
        IncomingAttachment(
            url="https://q.example/b",
            filename="big.bin",
            content_type="file",
            size=vault.MAX_FILE + 1,
        ),
    ]
    reply = send(bot, "#key 身份证", attachments=atts)
    assert "附件 2 没有保存：超过 20 MB" in reply

    row = conn.execute("SELECT * FROM secrets").fetchone()
    assert (row["label"], row["kind"], row["mime"], row["size"]) == (
        "身份证（附件 1）",
        "file",
        "image/jpeg",
        len(image),
    )
    sealed = (tmp_path / "data" / row["blob_path"]).read_bytes()
    assert opened(sk, sealed) == image
    for path in (tmp_path / "data").rglob("*"):
        if path.is_file():
            assert b"ID-CARD-PIXELS" not in path.read_bytes()


def test_empty_key_message_explains_usage(bot, conn):
    enable_vault(conn)
    assert "写法" in send(bot, "#key")


# ---- 接口 ----


def wrap_body() -> dict:
    return {
        "wrapped": b64(os.urandom(vault.WRAPPED_LEN)),
        "salt": b64(os.urandom(16)),
        "params": PARAMS,
    }


def setup_body(sk: PrivateKey) -> dict:
    return {
        "public_key": b64(bytes(sk.public_key)),
        "password": wrap_body(),
        "recovery": wrap_body(),
    }


def test_vault_api_setup_rewrap_and_secrets(client, app):
    setup_account(client, app)
    assert client.get("/api/vault").json()["initialized"] is False
    sk = PrivateKey.generate()

    bad = setup_body(sk)
    bad["password"]["wrapped"] = b64(b"short")
    assert client.post("/api/vault/setup", json=bad).status_code == 422
    assert client.post("/api/vault/setup", json=setup_body(sk)).json()["initialized"] is True
    assert client.post("/api/vault/setup", json=setup_body(sk)).status_code == 409
    keys = client.get("/api/vault/keys").json()
    assert keys["publicKey"] == b64(bytes(sk.public_key)) and keys["password"]["params"] == PARAMS

    # 修改包裹：先解开挑战证明持有私钥，挑战只能用一次
    new = wrap_body()
    ch = client.post("/api/vault/challenge").json()
    wrong = {"token": ch["token"], "answer": b64(os.urandom(32)), "password": new}
    assert client.put("/api/vault/keys", json=wrong).status_code == 403
    ch = client.post("/api/vault/challenge").json()
    answer = b64(opened(sk, base64.b64decode(ch["sealed"])))
    ok = {"token": ch["token"], "answer": answer, "password": new}
    assert client.put("/api/vault/keys", json=ok).json() == {"status": "ok"}
    assert client.put("/api/vault/keys", json=ok).status_code == 403
    assert client.get("/api/vault/keys").json()["password"]["wrapped"] == new["wrapped"]

    # 面板新增：浏览器加密后提交
    sealed = SealedBox(sk.public_key).encrypt(b"wifi-password-123")
    created = client.post(
        "/api/secrets", json={"label": "家里 Wi-Fi", "sealed": b64(sealed)}
    ).json()
    listed = client.get("/api/secrets").json()
    assert [s["id"] for s in listed] == [created["id"]]
    assert opened(sk, base64.b64decode(listed[0]["sealed"])) == b"wifi-password-123"
    assert client.get("/api/counts").json()["secret"] == 1

    # 误判时移出：变成普通条目，原密钥进回收站
    item = client.post(
        f"/api/secrets/{created['id']}/release", json={"text": "其实是普通笔记"}
    ).json()
    assert item["source"] == "panel" and item["partition"] == "inbox"
    assert client.get("/api/secrets").json() == []

    db = app.state.db
    other = vault.store_text(db, bytes(sk.public_key), "旧密钥", "x")
    assert client.delete(f"/api/secrets/{other['id']}").json() == {"status": "ok"}
    assert client.delete(f"/api/secrets/{other['id']}").status_code == 404
    actions = {r[0] for r in db.execute("SELECT action FROM audit_log")}
    assert {
        "vault_setup",
        "vault_open",
        "vault_rewrap",
        "secret_release",
        "secret_delete",
    } <= actions


def test_secret_blob_is_served_sealed(client, app):
    setup_account(client, app)
    sk = PrivateKey.generate()
    client.post("/api/vault/setup", json=setup_body(sk))
    secret = vault.store_file(
        app.state.db,
        app.state.config.data_dir,
        bytes(sk.public_key),
        "合同",
        b"PDF-BYTES",
        original_name="合同.pdf",
        mime="application/pdf",
    )
    resp = client.get(f"/api/secrets/{secret['id']}/blob")
    assert opened(sk, resp.content) == b"PDF-BYTES"
    assert client.get("/api/secrets/nope/blob").status_code == 404


def test_vault_requires_login(client):
    assert client.get("/api/vault").status_code == 401
    assert client.get("/api/secrets").status_code == 401
