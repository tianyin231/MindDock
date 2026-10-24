"""密钥库接口：启用、读取包裹后的私钥、修改二级密码，以及密钥的列表、密文、新增、删除、移出。

所有加解密都在浏览器里完成，这里只存取公钥、包裹后的私钥和密文。
"""

import base64
import binascii
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from minddock import vault
from minddock.api.deps import client_ip, get_db, require_user
from minddock.ingest import Incoming, ingest
from minddock.items import item_to_api
from minddock.util import audit

router = APIRouter(prefix="/api", tags=["vault"], dependencies=[Depends(require_user)])


def _dec(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="数据不是有效的 Base64") from None


def _enc(data: bytes) -> str:
    return base64.b64encode(data).decode()


def _challenges(request: Request) -> vault.Challenges:
    return request.app.state.vault_challenges


class WrapBody(BaseModel):
    wrapped: str
    salt: str
    params: dict[str, Any]

    def to_wrap(self) -> vault.Wrap:
        return vault.Wrap(_dec(self.wrapped), _dec(self.salt), self.params)


def _wrap_api(wrap: vault.Wrap) -> dict[str, Any]:
    return {"wrapped": _enc(wrap.wrapped), "salt": _enc(wrap.salt), "params": wrap.params}


# ---- 密钥库 ----


@router.get("/vault")
async def vault_state(request: Request) -> dict:
    m = vault.material(get_db(request))
    return {
        "initialized": m is not None,
        "publicKey": _enc(m["public_key"]) if m else None,
        "updatedAt": m["updated_at"] if m else None,
    }


class SetupBody(BaseModel):
    public_key: str
    password: WrapBody
    recovery: WrapBody


@router.post("/vault/setup")
async def vault_setup(body: SetupBody, request: Request) -> dict:
    db = get_db(request)
    try:
        vault.setup(db, _dec(body.public_key), body.password.to_wrap(), body.recovery.to_wrap())
    except vault.VaultError as exc:
        status = 409 if vault.initialized(db) else 422
        raise HTTPException(status_code=status, detail=str(exc)) from None
    audit(db, "vault_setup", None, client_ip(request))
    return await vault_state(request)


@router.get("/vault/keys")
async def vault_keys(request: Request) -> dict:
    db = get_db(request)
    m = vault.material(db)
    if m is None:
        raise HTTPException(status_code=404, detail="密钥库尚未启用")
    audit(db, "vault_open", None, client_ip(request))
    return {
        "publicKey": _enc(m["public_key"]),
        "password": _wrap_api(m["pw"]),
        "recovery": _wrap_api(m["rc"]),
    }


@router.post("/vault/challenge")
async def vault_challenge(request: Request) -> dict:
    pk = vault.public_key(get_db(request))
    if pk is None:
        raise HTTPException(status_code=404, detail="密钥库尚未启用")
    token, sealed = _challenges(request).issue(pk)
    return {"token": token, "sealed": _enc(sealed)}


class RewrapBody(BaseModel):
    token: str
    answer: str
    password: WrapBody
    recovery: WrapBody | None = None


@router.put("/vault/keys")
async def vault_rewrap(body: RewrapBody, request: Request) -> dict:
    """修改二级密码（或用恢复码重设并换新恢复码）。必须先解开挑战，证明持有私钥。"""
    db = get_db(request)
    if not _challenges(request).verify(body.token, _dec(body.answer)):
        raise HTTPException(status_code=403, detail="验证失败，请重新解锁后再试")
    try:
        vault.rewrap(
            db, body.password.to_wrap(), body.recovery.to_wrap() if body.recovery else None
        )
    except vault.VaultError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    audit(db, "vault_recover" if body.recovery else "vault_rewrap", None, client_ip(request))
    return {"status": "ok"}


# ---- 密钥 ----


def _secret_or_404(request: Request, secret_id: str):
    row = vault.get_secret(get_db(request), secret_id)
    if row is None:
        raise HTTPException(status_code=404, detail="密钥不存在")
    return row


@router.get("/secrets")
async def list_secrets(request: Request) -> list[dict]:
    """名称等信息是明文；文本密钥附带密文，解锁后在浏览器里批量解密。"""
    return [
        {**vault.secret_to_api(r), "sealed": _enc(r["sealed"]) if r["sealed"] else None}
        for r in vault.list_secrets(get_db(request))
    ]


@router.get("/secrets/{secret_id}/blob")
async def secret_blob(secret_id: str, request: Request) -> FileResponse:
    row = _secret_or_404(request, secret_id)
    data_dir: Path = request.app.state.config.data_dir.resolve()
    path = (data_dir / (row["blob_path"] or "")).resolve()
    if row["kind"] != "file" or not path.is_relative_to(data_dir) or not path.is_file():
        raise HTTPException(status_code=404, detail="密文文件不存在")
    audit(get_db(request), "secret_file", secret_id, client_ip(request))
    return FileResponse(path, media_type="application/octet-stream")


class NewSecret(BaseModel):
    label: str = Field(min_length=1, max_length=60)
    sealed: str


@router.post("/secrets")
async def add_secret(body: NewSecret, request: Request) -> dict:
    db = get_db(request)
    if not vault.initialized(db):
        raise HTTPException(status_code=409, detail="密钥库尚未启用")
    try:
        return vault.store_sealed_text(db, body.label, _dec(body.sealed))
    except vault.VaultError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


@router.delete("/secrets/{secret_id}")
async def delete_secret(secret_id: str, request: Request) -> dict:
    _secret_or_404(request, secret_id)
    db = get_db(request)
    vault.trash(db, secret_id)
    audit(db, "secret_delete", secret_id, client_ip(request))
    return {"status": "ok"}


class ReleaseBody(BaseModel):
    text: str = Field(min_length=1, max_length=vault.MAX_TEXT)


@router.post("/secrets/{secret_id}/release")
async def release_secret(secret_id: str, body: ReleaseBody, request: Request) -> dict:
    """误判时移出密钥库：浏览器解密后把明文交回，作为普通条目重新整理，原密钥进回收站。"""
    row = _secret_or_404(request, secret_id)
    if row["kind"] != "text":
        raise HTTPException(status_code=422, detail="附件类密钥暂不支持移出")
    db = get_db(request)
    result = ingest(db, Incoming(msg_id=None, openid="", content=body.text), source="panel")
    vault.trash(db, secret_id)
    audit(db, "secret_release", secret_id, client_ip(request))
    return item_to_api(db, result.item_id)
