"""口令哈希、随机令牌，以及面板设置的对称加密。"""

import base64
import hashlib
import logging
import secrets
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from nacl.secret import SecretBox
from nacl.utils import random as nacl_random

log = logging.getLogger(__name__)
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    """数据库只存令牌的哈希，库泄露也无法冒用会话。"""
    return hashlib.sha256(token.encode()).hexdigest()


class Cipher:
    """用主密钥加解密设置里的敏感字段（XSalsa20-Poly1305）。"""

    PREFIX = "enc1:"

    def __init__(self, key: bytes):
        self._box = SecretBox(key)

    def encrypt(self, plaintext: str) -> str:
        sealed = self._box.encrypt(plaintext.encode())
        return self.PREFIX + base64.b64encode(sealed).decode()

    def decrypt(self, value: str) -> str:
        if not value.startswith(self.PREFIX):
            raise ValueError("不是加密值")
        return self._box.decrypt(base64.b64decode(value[len(self.PREFIX) :])).decode()


def load_cipher(secret_key: str, data_dir: Path) -> Cipher:
    if secret_key:
        key = base64.b64decode(secret_key)
    else:
        path = data_dir / "secret.key"
        if not path.exists():
            log.warning("未设置 MINDDOCK_SECRET_KEY，已在 %s 生成开发用密钥", path)
            data_dir.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64encode(nacl_random(SecretBox.KEY_SIZE)))
        key = base64.b64decode(path.read_bytes())
    if len(key) != SecretBox.KEY_SIZE:
        raise ValueError("MINDDOCK_SECRET_KEY 必须是 base64 编码的 32 字节")
    return Cipher(key)
