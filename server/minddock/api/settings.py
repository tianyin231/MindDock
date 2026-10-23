"""面板设置接口：读取、保存、测试连接。"""

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from minddock.api.deps import require_user
from minddock.integrations.openlist import OpenListClient
from minddock.integrations.probes import (
    ProbeResult,
    probe_ai,
    probe_notify,
    probe_qq,
    probe_storage,
)
from minddock.settings_store import SECTIONS, SettingsError, SettingsStore

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/settings", tags=["settings"], dependencies=[Depends(require_user)])


def _store(request: Request) -> SettingsStore:
    return SettingsStore(request.app.state.db, request.app.state.cipher)


@router.get("")
async def list_settings(request: Request) -> dict:
    store = _store(request)
    return {"sections": [store.public(key) for key in SECTIONS]}


class UpdateBody(BaseModel):
    values: dict[str, Any]


@router.put("/{section}")
async def update_settings(section: str, body: UpdateBody, request: Request) -> dict:
    store = _store(request)
    try:
        store.update(section, body.values)
    except SettingsError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return store.public(section)


@router.post("/{section}/test")
async def test_settings(section: str, request: Request) -> dict:
    store = _store(request)
    if section not in SECTIONS:
        raise HTTPException(status_code=404, detail="未知的设置分组")
    if not store.configured(section):
        return {"ok": False, "message": "请先填写并保存必填项", "details": {}}

    cfg = store.get(section)
    http = request.app.state.http
    try:
        if section == "qq":
            result = await probe_qq(cfg, http)
        elif section == "ai":
            result = await probe_ai(cfg, http)
        elif section == "storage":
            config = request.app.state.config
            openlist = OpenListClient(config.openlist_url, config.openlist_admin_password, http)
            result = await probe_storage(cfg, openlist)
        else:
            result = await probe_notify(cfg)
    except Exception as exc:  # 网络错误、对方返回异常格式等，统一作为失败结果返回
        log.warning("测试 %s 出错：%s", section, type(exc).__name__)
        result = ProbeResult(False, f"测试出错：{exc}")
    return {"ok": result.ok, "message": result.message, "details": result.details}
