"""接口共用的依赖：数据库、配置、当前用户。"""

import sqlite3
from dataclasses import dataclass

from fastapi import HTTPException, Request

from minddock.config import Settings
from minddock.db import now_iso
from minddock.security import token_hash

SESSION_COOKIE = "md_session"
DEVICE_COOKIE = "md_device"


@dataclass(frozen=True)
class CurrentUser:
    id: int
    username: str
    session_id: str


def get_db(request: Request) -> sqlite3.Connection:
    return request.app.state.db


def get_config(request: Request) -> Settings:
    return request.app.state.config


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def current_user(request: Request) -> CurrentUser | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    row = (
        get_db(request)
        .execute(
            "SELECT s.id, s.user_id, s.expires_at, u.username FROM sessions s "
            "JOIN users u ON u.id = s.user_id WHERE s.id = ?",
            (token_hash(token),),
        )
        .fetchone()
    )
    if row is None or row["expires_at"] <= now_iso():
        return None
    return CurrentUser(id=row["user_id"], username=row["username"], session_id=row["id"])


async def require_user(request: Request) -> CurrentUser:
    # async：避免 FastAPI 把依赖放进线程池，与事件循环线程并发访问同一个 SQLite 连接
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    return user
