"""QQ 开放平台 OpenAPI：access_token、网关地址、单聊消息。"""

import asyncio
import time
from typing import Any

import httpx2

TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
API = "https://api.sgroup.qq.com"
SANDBOX_API = "https://sandbox.api.sgroup.qq.com"


class QQError(RuntimeError):
    pass


def _error_text(resp: httpx2.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}"
    if isinstance(body, dict) and body.get("message"):
        return f"{body['message']}（{body.get('code', resp.status_code)}）"
    return f"HTTP {resp.status_code}"


class QQApi:
    def __init__(self, app_id: str, app_secret: str, sandbox: bool, http: httpx2.AsyncClient):
        self.app_id = str(app_id)
        self._secret = app_secret
        self.base = SANDBOX_API if sandbox else API
        self._http = http
        self._token: str | None = None
        self._expires = 0.0
        self._lock = asyncio.Lock()

    async def token(self) -> str:
        async with self._lock:
            if self._token and time.monotonic() < self._expires - 60:
                return self._token
            resp = await self._http.post(
                TOKEN_URL, json={"appId": self.app_id, "clientSecret": self._secret}
            )
            body = resp.json() if resp.status_code == 200 else {}
            if not body.get("access_token"):
                raise QQError(f"获取 access_token 失败：{_error_text(resp)}")
            self._token = body["access_token"]
            self._expires = time.monotonic() + int(body.get("expires_in") or 7200)
            return self._token

    def invalidate(self) -> None:
        self._token = None

    async def _headers(self) -> dict[str, str]:
        return {"Authorization": f"QQBot {await self.token()}", "X-Union-Appid": self.app_id}

    async def gateway_url(self) -> str:
        resp = await self._http.get(f"{self.base}/gateway", headers=await self._headers())
        url = resp.json().get("url") if resp.status_code == 200 else None
        if not url:
            raise QQError(f"获取网关地址失败：{_error_text(resp)}")
        return url

    async def send_c2c(
        self, openid: str, content: str, msg_id: str | None = None, msg_seq: int = 1
    ) -> dict[str, Any]:
        """有 msg_id 时为被动回复（同一消息的 msg_seq 需递增）；没有则为主动消息。"""
        body: dict[str, Any] = {"content": content, "msg_type": 0}
        if msg_id:
            body.update(msg_id=msg_id, msg_seq=msg_seq)
        resp = await self._http.post(
            f"{self.base}/v2/users/{openid}/messages", json=body, headers=await self._headers()
        )
        if resp.status_code >= 400:
            raise QQError(f"发送消息失败：{_error_text(resp)}")
        return resp.json()
