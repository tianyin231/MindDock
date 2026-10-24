"""QQ 机器人状态与绑定。"""

import secrets

import httpx2
from fastapi import APIRouter, Depends, Request

from minddock.api.deps import get_db, require_user
from minddock.bot import BIND_KEY, OWNER_KEY, STATUS_KEY
from minddock.db import now_iso
from minddock.qq.api import QQApi, QQError
from minddock.settings_store import SettingsStore
from minddock.util import kv_delete, kv_get, kv_set

router = APIRouter(prefix="/api/qq", tags=["qq"], dependencies=[Depends(require_user)])

BIND_TTL = 600
# bot 每 5 秒刷新一次状态，超过这个时间没刷新就视为离线（比如 bot 容器没在运行）
STALE_SECONDS = 60


def _view(request: Request) -> dict:
    db = get_db(request)
    store = SettingsStore(db, request.app.state.cipher)
    status = kv_get(db, STATUS_KEY) or {
        "state": "stopped",
        "detail": "机器人服务未运行",
        "updated_at": None,
    }
    alive = bool(status.get("updated_at")) and status["updated_at"] > now_iso(-STALE_SECONDS)
    if not alive:
        status = {**status, "state": "stopped", "detail": "机器人服务未运行或已失去响应"}
    owner = kv_get(db, OWNER_KEY)
    bind = kv_get(db, BIND_KEY)
    if bind and bind["expires_at"] <= now_iso():
        bind = None
    return {
        "configured": store.configured("qq"),
        "status": {
            "state": status["state"],
            "detail": status.get("detail", ""),
            "online": status["state"] == "online",
        },
        "owner": {"bound": owner is not None, "bound_at": owner["bound_at"] if owner else None},
        "bind": {"code": bind["code"], "expires_at": bind["expires_at"]} if bind else None,
    }


@router.get("")
async def qq_state(request: Request) -> dict:
    return _view(request)


@router.post("/bind")
async def create_bind_code(request: Request) -> dict:
    code = f"{secrets.randbelow(1_000_000):06d}"
    kv_set(
        get_db(request), BIND_KEY, {"code": code, "expires_at": now_iso(BIND_TTL), "attempts": 0}
    )
    return _view(request)


@router.post("/test")
async def send_test(request: Request) -> dict:
    """直接发一条主动消息，检查到点提醒能否送达（主动消息额度有限，不要频繁测试）。"""
    db = get_db(request)
    store = SettingsStore(db, request.app.state.cipher)
    owner = kv_get(db, OWNER_KEY)
    if not store.configured("qq") or owner is None:
        return {"ok": False, "message": "请先填写机器人设置并绑定你的 QQ"}
    cfg = store.get("qq")
    api = QQApi(cfg["app_id"], cfg["app_secret"], bool(cfg.get("sandbox")), request.app.state.http)
    try:
        await api.send_c2c(owner["openid"], "🔔 MindDock 测试：收到这条，说明到点提醒可以送达。")
    except (QQError, httpx2.HTTPError) as exc:
        return {"ok": False, "message": f"主动消息发送失败：{exc}"}
    return {"ok": True, "message": "已发送，请在 QQ 中查看"}


@router.delete("/owner")
async def unbind(request: Request) -> dict:
    kv_delete(get_db(request), OWNER_KEY)
    return _view(request)
