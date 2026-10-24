"""密钥库：入库时用公钥加密（libsodium sealed box），解密只在浏览器里进行。

服务器只保存公钥，以及分别用二级密码和恢复码（Argon2id 派生）包裹的两份私钥，
从不接触二级密码和明文私钥。修改包裹需要先解开服务器发的挑战，证明手里有私钥。
"""

import json
import os
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nacl.public import PublicKey, SealedBox

from minddock.db import now_iso
from minddock.util import emit, new_code, new_id

MAX_FILE = 20 * 1024 * 1024
MAX_TEXT = 64 * 1024
VAULT_DIR = "vault"
WRAPPED_LEN = 24 + 32 + 16  # nonce + 私钥 + MAC
SALT_LEN = 16
SEAL_OVERHEAD = 32 + 16  # 临时公钥 + MAC
CHALLENGE_TTL = 120
UNNAMED = "未命名密钥"
_EXPLICIT = re.compile(r"(?i)^\s*#key")


class VaultError(ValueError):
    pass


# ---- 密钥材料 ----


@dataclass(frozen=True)
class Wrap:
    """一份包裹后的私钥：密文（nonce + secretbox）、盐、Argon2id 参数。"""

    wrapped: bytes
    salt: bytes
    params: dict[str, Any]

    def validate(self) -> None:
        if len(self.wrapped) != WRAPPED_LEN or len(self.salt) != SALT_LEN:
            raise VaultError("包裹后的私钥格式不正确")
        p = self.params
        if (
            p.get("alg") != "argon2id13"
            or not 1 <= int(p.get("ops", 0)) <= 10
            or not 8 << 20 <= int(p.get("mem", 0)) <= 1 << 30
        ):
            raise VaultError("密钥派生参数不正确")


def initialized(conn: sqlite3.Connection) -> bool:
    return conn.execute("SELECT 1 FROM vault_keys WHERE id = 1").fetchone() is not None


def public_key(conn: sqlite3.Connection) -> bytes | None:
    row = conn.execute("SELECT public_key FROM vault_keys WHERE id = 1").fetchone()
    return bytes(row[0]) if row else None


def setup(conn: sqlite3.Connection, pk: bytes, pw: Wrap, rc: Wrap) -> None:
    if len(pk) != 32:
        raise VaultError("公钥格式不正确")
    pw.validate()
    rc.validate()
    now = now_iso()
    cur = conn.execute(
        "INSERT OR IGNORE INTO vault_keys (id, public_key, sk_wrapped_pw, pw_salt, pw_params, "
        "sk_wrapped_rc, rc_salt, rc_params, created_at, updated_at) "
        "VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            pk,
            pw.wrapped,
            pw.salt,
            json.dumps(pw.params),
            rc.wrapped,
            rc.salt,
            json.dumps(rc.params),
            now,
            now,
        ),
    )
    if cur.rowcount == 0:
        raise VaultError("密钥库已经启用过了")


def material(conn: sqlite3.Connection) -> dict[str, Any] | None:
    row = conn.execute("SELECT * FROM vault_keys WHERE id = 1").fetchone()
    if row is None:
        return None
    return {
        "public_key": bytes(row["public_key"]),
        "pw": Wrap(
            bytes(row["sk_wrapped_pw"]), bytes(row["pw_salt"]), json.loads(row["pw_params"])
        ),
        "rc": Wrap(
            bytes(row["sk_wrapped_rc"]), bytes(row["rc_salt"]), json.loads(row["rc_params"])
        ),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def rewrap(conn: sqlite3.Connection, pw: Wrap, rc: Wrap | None = None) -> None:
    """修改二级密码；用恢复码重设时同时换一个新的恢复码。"""
    pw.validate()
    if rc:
        rc.validate()
    sets = ["sk_wrapped_pw = ?", "pw_salt = ?", "pw_params = ?", "updated_at = ?"]
    args: list[Any] = [pw.wrapped, pw.salt, json.dumps(pw.params), now_iso()]
    if rc:
        sets += ["sk_wrapped_rc = ?", "rc_salt = ?", "rc_params = ?"]
        args += [rc.wrapped, rc.salt, json.dumps(rc.params)]
    cur = conn.execute(f"UPDATE vault_keys SET {', '.join(sets)} WHERE id = 1", args)
    if cur.rowcount == 0:
        raise VaultError("密钥库尚未启用")


class Challenges:
    """证明持有私钥：服务器用公钥加密一段随机数，浏览器解开后原样交回。只在面板进程内存里保存。"""

    def __init__(self) -> None:
        self._pending: dict[str, tuple[bytes, float]] = {}

    def issue(self, pk: bytes) -> tuple[str, bytes]:
        now = time.monotonic()
        self._pending = {k: v for k, v in self._pending.items() if v[1] > now}
        token, answer = secrets.token_urlsafe(16), os.urandom(32)
        self._pending[token] = (answer, now + CHALLENGE_TTL)
        return token, seal(pk, answer)

    def verify(self, token: str, answer: bytes) -> bool:
        expected = self._pending.pop(token, None)
        return (
            expected is not None
            and expected[1] > time.monotonic()
            and secrets.compare_digest(expected[0], answer)
        )


# ---- 加密入库 ----


def seal(pk: bytes, data: bytes) -> bytes:
    return SealedBox(PublicKey(pk)).encrypt(data)


def secret_to_api(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "code": row["short_code"],
        "label": row["label"],
        "kind": row["kind"],
        "size": row["size"],
        "originalName": row["original_name"],
        "mime": row["mime"],
        "source": row["source"],
        "detected": row["detected"],
        "createdAt": row["created_at"],
    }


def _insert(
    conn: sqlite3.Connection,
    *,
    label: str,
    kind: str,
    size: int,
    source: str,
    msg_id: str | None,
    detected: str | None,
    sealed: bytes | None = None,
    blob_path: str | None = None,
    original_name: str | None = None,
    mime: str | None = None,
) -> dict[str, Any]:
    secret_id = new_id()
    conn.execute(
        "INSERT INTO secrets (id, short_code, label, kind, sealed, blob_path, original_name, mime, "
        "size, source, detected, source_msg_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            secret_id,
            new_code(conn),
            label.strip()[:60] or UNNAMED,
            kind,
            sealed,
            blob_path,
            original_name,
            mime,
            size,
            source,
            detected,
            msg_id,
            now_iso(),
        ),
    )
    row = conn.execute("SELECT * FROM secrets WHERE id = ?", (secret_id,)).fetchone()
    secret = secret_to_api(row)
    emit(conn, "secret.stored", {"secret": secret})
    return secret


def store_text(
    conn: sqlite3.Connection,
    pk: bytes,
    label: str,
    text: str,
    *,
    source: str = "qq",
    msg_id: str | None = None,
    detected: str | None = None,
) -> dict[str, Any]:
    data = text.encode()
    if len(data) > MAX_TEXT:
        raise VaultError("密钥内容超过 64 KB")
    return _insert(
        conn,
        label=label,
        kind="text",
        size=len(data),
        source=source,
        msg_id=msg_id,
        detected=detected,
        sealed=seal(pk, data),
    )


def store_sealed_text(conn: sqlite3.Connection, label: str, sealed: bytes) -> dict[str, Any]:
    """面板新增：浏览器已用公钥加密，服务器只核对长度。"""
    if not SEAL_OVERHEAD < len(sealed) <= MAX_TEXT + SEAL_OVERHEAD:
        raise VaultError("密文格式不正确")
    return _insert(
        conn,
        label=label,
        kind="text",
        size=len(sealed) - SEAL_OVERHEAD,
        source="panel",
        msg_id=None,
        detected=None,
        sealed=sealed,
    )


def store_file(
    conn: sqlite3.Connection,
    data_dir: Path,
    pk: bytes,
    label: str,
    data: bytes,
    *,
    original_name: str | None,
    mime: str | None,
    msg_id: str | None = None,
    detected: str | None = None,
) -> dict[str, Any]:
    """附件整体加密后写入 data/vault/，明文只在内存里出现。"""
    if len(data) > MAX_FILE:
        raise VaultError("密钥附件超过 20 MB")
    relative = Path(VAULT_DIR) / f"{new_id()}.sealed"
    target = data_dir / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".part")
    partial.write_bytes(seal(pk, data))
    partial.replace(target)
    return _insert(
        conn,
        label=label,
        kind="file",
        size=len(data),
        source="qq",
        msg_id=msg_id,
        detected=detected,
        blob_path=relative.as_posix(),
        original_name=original_name,
        mime=mime,
    )


def list_secrets(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM secrets WHERE trashed_at IS NULL ORDER BY created_at DESC"
    ).fetchall()


def get_secret(conn: sqlite3.Connection, secret_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM secrets WHERE id = ? AND trashed_at IS NULL", (secret_id,)
    ).fetchone()


def trash(conn: sqlite3.Connection, secret_id: str) -> bool:
    cur = conn.execute(
        "UPDATE secrets SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL",
        (now_iso(), secret_id),
    )
    return cur.rowcount > 0


# ---- 从 QQ 消息里拆出名称和内容 ----


def split_message(text: str, has_attachments: bool, detected: str | None) -> tuple[str, str]:
    """返回（名称，文字内容）。

    显式 #key：第一行是名称，之后是内容；只有一行时，第一个词是名称、其余是内容，
    只有一个词且没有附件时它就是内容。自动识别的消息整条都是内容，名称取识别原因。
    """
    if detected:
        return detected.removeprefix("包含").strip() or "密钥", text.strip()
    body = _EXPLICIT.sub("", text, count=1)
    first, _, rest = body.partition("\n")
    first, rest = first.strip(), rest.strip()
    if rest:
        return first or UNNAMED, rest
    if has_attachments:
        return first or UNNAMED, ""
    name, _, value = first.partition(" ")
    if value.strip():
        return name, value.strip()
    return UNNAMED, first
