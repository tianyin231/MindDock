"""账号与登录。

- 首次使用：凭服务器日志里的一次性初始化码创建唯一账号，并绑定验证器（TOTP）。
- 日常登录：密码；在新浏览器上额外输入验证码，可信任该设备 30 天。
- 会话与设备令牌只在 Cookie 里，数据库只存哈希。
"""

import logging
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Annotated

import pyotp
import segno
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from minddock.api.deps import (
    DEVICE_COOKIE,
    SESSION_COOKIE,
    CurrentUser,
    current_user,
    get_config,
    get_db,
    require_user,
)
from minddock.db import now_iso
from minddock.security import hash_password, new_token, token_hash, verify_password

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_TTL = 30 * 86400
DEVICE_TTL = 30 * 86400
PENDING_TTL = 300
MIN_PASSWORD_LEN = 10


# ---- 内存状态（单进程） ----


class LoginLimiter:
    """同一 IP：1 分钟内失败 5 次，或 15 分钟内失败 10 次，即暂时拒绝。"""

    def __init__(self) -> None:
        self._failures: dict[str, deque[float]] = {}

    def retry_after(self, key: str) -> int:
        now = time.monotonic()
        q = self._failures.get(key)
        if not q:
            return 0
        while q and now - q[0] > 900:
            q.popleft()
        recent = [t for t in q if now - t <= 60]
        if len(recent) >= 5:
            return int(60 - (now - recent[0])) + 1
        if len(q) >= 10:
            return int(900 - (now - q[0])) + 1
        return 0

    def fail(self, key: str) -> None:
        self._failures.setdefault(key, deque()).append(time.monotonic())

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)


@dataclass
class Pending:
    user_id: int | None
    expires: float
    totp_secret: str = ""
    username: str = ""
    password_hash: str = ""
    attempts: int = 0


@dataclass
class AuthState:
    setup_code: str | None = None
    pending: dict[str, Pending] = field(default_factory=dict)
    limiter: LoginLimiter = field(default_factory=LoginLimiter)
    last_totp_step: dict[int, int] = field(default_factory=dict)

    def take(self, token: str) -> Pending:
        item = self.pending.get(token)
        if item is None or item.expires < time.monotonic():
            self.pending.pop(token, None)
            raise HTTPException(status_code=400, detail="操作已过期，请重新开始")
        return item


def init_auth_state(db) -> AuthState:
    state = AuthState()
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
        code = secrets.token_hex(4).upper()
        state.setup_code = f"{code[:4]}-{code[4:]}"
        log.warning("MindDock 尚未初始化。初始化码：%s（仅用于首次创建账号）", state.setup_code)
    return state


def _state(request: Request) -> AuthState:
    return request.app.state.auth


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _guard(request: Request) -> str:
    key = _client_key(request)
    wait = _state(request).limiter.retry_after(key)
    if wait:
        raise HTTPException(
            status_code=429, detail=f"尝试次数过多，请 {max(1, wait // 60)} 分钟后再试"
        )
    return key


def _verify_totp(state: AuthState, user_id: int | None, secret: str, code: str) -> bool:
    totp = pyotp.TOTP(secret)
    code = code.strip().replace(" ", "")
    now = time.time()
    for offset in (-1, 0, 1):
        step = int(now // 30) + offset
        if secrets.compare_digest(totp.at(step * 30), code):
            # 同一个验证码只能用一次
            if user_id is not None and state.last_totp_step.get(user_id, -1) >= step:
                return False
            if user_id is not None:
                state.last_totp_step[user_id] = step
            return True
    return False


def _set_cookie(request: Request, response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name,
        value,
        max_age=max_age,
        httponly=True,
        secure=get_config(request).cookie_secure,
        samesite="strict",
        path="/",
    )


def _start_session(request: Request, response: Response, user_id: int, trust_device: bool) -> None:
    db = get_db(request)
    ua = request.headers.get("user-agent", "")[:200]
    token = new_token()
    db.execute(
        "INSERT INTO sessions (id, user_id, totp_verified_at, ip, user_agent, created_at, "
        "last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            token_hash(token),
            user_id,
            now_iso(),
            _client_key(request),
            ua,
            now_iso(),
            now_iso(),
            now_iso(SESSION_TTL),
        ),
    )
    db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso(),))
    _set_cookie(request, response, SESSION_COOKIE, token, SESSION_TTL)
    if trust_device:
        device = new_token()
        db.execute(
            "INSERT INTO trusted_devices (id, user_id, user_agent, created_at, last_seen_at, "
            "expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            (token_hash(device), user_id, ua, now_iso(), now_iso(), now_iso(DEVICE_TTL)),
        )
        _set_cookie(request, response, DEVICE_COOKIE, device, DEVICE_TTL)
    db.execute(
        "INSERT INTO audit_log (at, action, target, ip) VALUES (?, 'login', ?, ?)",
        (now_iso(), str(user_id), _client_key(request)),
    )


def _trusted(request: Request, user_id: int) -> bool:
    device = request.cookies.get(DEVICE_COOKIE)
    if not device:
        return False
    row = (
        get_db(request)
        .execute(
            "SELECT id FROM trusted_devices WHERE id = ? AND user_id = ? AND expires_at > ?",
            (token_hash(device), user_id, now_iso()),
        )
        .fetchone()
    )
    if row:
        get_db(request).execute(
            "UPDATE trusted_devices SET last_seen_at = ? WHERE id = ?", (now_iso(), row["id"])
        )
    return row is not None


# ---- 接口 ----


@router.get("/state")
async def state(request: Request) -> dict:
    user = current_user(request)
    return {
        "setup_required": _state(request).setup_code is not None,
        "authenticated": user is not None,
        "username": user.username if user else None,
    }


class SetupStart(BaseModel):
    setup_code: str
    username: str
    password: str


@router.post("/setup/start")
async def setup_start(body: SetupStart, request: Request) -> dict:
    st = _state(request)
    key = _guard(request)
    if st.setup_code is None:
        raise HTTPException(status_code=409, detail="已经初始化过了")
    if not secrets.compare_digest(body.setup_code.strip().upper(), st.setup_code):
        st.limiter.fail(key)
        raise HTTPException(status_code=403, detail="初始化码不正确，请查看服务器日志")
    username = body.username.strip()
    if not 2 <= len(username) <= 32:
        raise HTTPException(status_code=422, detail="用户名长度需要 2 到 32 个字符")
    if len(body.password) < MIN_PASSWORD_LEN:
        raise HTTPException(status_code=422, detail=f"密码至少 {MIN_PASSWORD_LEN} 位")

    secret = pyotp.random_base32()
    token = new_token()
    st.pending[token] = Pending(
        user_id=None,
        expires=time.monotonic() + PENDING_TTL * 2,
        totp_secret=secret,
        username=username,
        password_hash=hash_password(body.password),
    )
    uri = pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name="MindDock")
    return {
        "setup_token": token,
        "totp_secret": secret,
        "totp_uri": uri,
        # 完整的 data URI（含 SVG 命名空间），前端可直接作为图片地址
        "totp_qr": segno.make(uri, error="m").svg_data_uri(scale=5, border=2),
    }


class SetupFinish(BaseModel):
    setup_token: str
    code: str


@router.post("/setup/finish")
async def setup_finish(body: SetupFinish, request: Request, response: Response) -> dict:
    st = _state(request)
    pending = st.take(body.setup_token)
    if st.setup_code is None:
        raise HTTPException(status_code=409, detail="已经初始化过了")
    if not _verify_totp(st, None, pending.totp_secret, body.code):
        raise HTTPException(status_code=400, detail="验证码不正确，请确认手机时间准确后重试")

    cipher = request.app.state.cipher
    db = get_db(request)
    cur = db.execute(
        "INSERT INTO users (username, password_hash, totp_secret_enc, created_at) "
        "VALUES (?, ?, ?, ?)",
        (pending.username, pending.password_hash, cipher.encrypt(pending.totp_secret), now_iso()),
    )
    st.setup_code = None
    st.pending.pop(body.setup_token, None)
    _start_session(request, response, cur.lastrowid, trust_device=True)
    log.info("已创建账号 %s", pending.username)
    return {"status": "ok"}


class LoginBody(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    st = _state(request)
    key = _guard(request)
    row = (
        get_db(request)
        .execute("SELECT id, password_hash FROM users WHERE username = ?", (body.username.strip(),))
        .fetchone()
    )
    if row is None or not verify_password(row["password_hash"], body.password):
        st.limiter.fail(key)
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if _trusted(request, row["id"]):
        st.limiter.reset(key)
        _start_session(request, response, row["id"], trust_device=False)
        return {"status": "ok"}

    challenge = new_token()
    st.pending[challenge] = Pending(user_id=row["id"], expires=time.monotonic() + PENDING_TTL)
    return {"status": "totp_required", "challenge": challenge}


class TotpBody(BaseModel):
    challenge: str
    code: str
    trust_device: bool = True


@router.post("/login/totp")
async def login_totp(body: TotpBody, request: Request, response: Response) -> dict:
    st = _state(request)
    key = _guard(request)
    pending = st.take(body.challenge)
    row = (
        get_db(request)
        .execute("SELECT totp_secret_enc FROM users WHERE id = ?", (pending.user_id,))
        .fetchone()
    )
    secret = request.app.state.cipher.decrypt(row["totp_secret_enc"])
    if not _verify_totp(st, pending.user_id, secret, body.code):
        st.limiter.fail(key)
        pending.attempts += 1
        if pending.attempts >= 5:
            st.pending.pop(body.challenge, None)
        raise HTTPException(status_code=401, detail="验证码不正确")

    st.pending.pop(body.challenge, None)
    st.limiter.reset(key)
    _start_session(request, response, pending.user_id, trust_device=body.trust_device)
    return {"status": "ok"}


@router.post("/logout")
async def logout(
    request: Request, response: Response, user: Annotated[CurrentUser, Depends(require_user)]
) -> dict:
    get_db(request).execute("DELETE FROM sessions WHERE id = ?", (user.session_id,))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "ok"}
