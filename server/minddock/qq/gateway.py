"""QQ 机器人网关（WebSocket）：保持常驻连接，断线自动重连并尽量恢复会话。

协议要点：连上后服务端发 Hello(op 10) 给出心跳间隔；客户端发 Identify(op 2) 或 Resume(op 6)；
之后按间隔发 Heartbeat(op 1)，事件以 Dispatch(op 0) 推送，s 为序号，用于恢复会话。
"""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from minddock.qq.api import QQApi

log = logging.getLogger(__name__)

INTENT_GROUP_AND_C2C = 1 << 25

# 会话已失效，需要重新 Identify
RESET_SESSION_CODES = {4006, 4007, 4009}
# 无法通过重连恢复，需要用户处理
FATAL_CODES = {
    4013: "intents 无效",
    4014: "没有单聊消息权限，请在 QQ 开放平台开启",
    4914: "机器人已下架，只能在沙箱中连接",
    4915: "机器人已被封禁",
}

DispatchHandler = Callable[[str, dict[str, Any]], Awaitable[None]]
StatusHandler = Callable[[str, str], None]


class FatalGatewayError(RuntimeError):
    pass


class Gateway:
    def __init__(
        self,
        api: QQApi,
        on_dispatch: DispatchHandler,
        on_status: StatusHandler,
        intents: int = INTENT_GROUP_AND_C2C,
    ):
        self.api = api
        self.on_dispatch = on_dispatch
        self.on_status = on_status
        self.intents = intents
        self.session_id: str | None = None
        self.seq: int | None = None
        self.last_ack = 0.0
        self._tasks: set[asyncio.Task] = set()

    # ---- 报文 ----

    def identify_payload(self, token: str) -> dict[str, Any]:
        return {
            "op": 2,
            "d": {
                "token": f"QQBot {token}",
                "intents": self.intents,
                "shard": [0, 1],
                "properties": {"$os": "linux", "$browser": "minddock", "$device": "minddock"},
            },
        }

    def resume_payload(self, token: str) -> dict[str, Any]:
        return {
            "op": 6,
            "d": {"token": f"QQBot {token}", "session_id": self.session_id, "seq": self.seq},
        }

    def handle(self, payload: dict[str, Any]) -> bool:
        """处理一帧；返回 False 表示需要断开重连。"""
        op = payload.get("op")
        if payload.get("s") is not None:
            self.seq = payload["s"]
        if op == 0:
            event, data = payload.get("t"), payload.get("d") or {}
            if event == "READY":
                self.session_id = data.get("session_id")
                self.on_status("online", "已连接")
            elif event == "RESUMED":
                self.on_status("online", "已恢复连接")
            else:
                self._spawn(self.on_dispatch(event, data))
        elif op == 11:
            self.last_ack = time.monotonic()
        elif op == 7:  # 服务端要求重连：保留会话，稍后恢复
            return False
        elif op == 9:  # 会话无效：下次重新 Identify
            self.session_id = self.seq = None
            return False
        return True

    def handle_close(self, code: int | None) -> None:
        if code in FATAL_CODES:
            raise FatalGatewayError(f"{FATAL_CODES[code]}（{code}）")
        if code == 4004:  # token 无效
            self.api.invalidate()
        if code in RESET_SESSION_CODES:
            self.session_id = self.seq = None

    # ---- 连接 ----

    def _spawn(self, coro: Awaitable[None]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)

        def done(t: asyncio.Task) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception():
                log.error("处理事件出错", exc_info=t.exception())

        task.add_done_callback(done)

    async def _heartbeat(self, ws: ClientConnection, interval: float) -> None:
        try:
            while True:
                await asyncio.sleep(interval)
                await ws.send(json.dumps({"op": 1, "d": self.seq}))
        except ConnectionClosed:
            return

    async def connect_once(self) -> None:
        url = await self.api.gateway_url()
        if not url.lower().startswith("wss://"):
            raise RuntimeError("QQ 网关地址不是 wss://，为避免明文传输已拒绝连接")
        async with connect(url, open_timeout=20, ping_interval=None, max_size=2**22) as ws:
            hello = json.loads(await asyncio.wait_for(ws.recv(), 20))
            if hello.get("op") != 10:
                raise RuntimeError(f"网关首帧不是 Hello：op={hello.get('op')}")
            interval = hello["d"]["heartbeat_interval"] / 1000
            token = await self.api.token()
            resuming = bool(self.session_id and self.seq is not None)
            first = self.resume_payload(token) if resuming else self.identify_payload(token)
            await ws.send(json.dumps(first))
            beat = asyncio.create_task(self._heartbeat(ws, interval))
            try:
                async for raw in ws:
                    if not self.handle(json.loads(raw)):
                        break
            finally:
                beat.cancel()

    async def run_forever(self) -> None:
        delay = 1.0
        while True:
            self.on_status("connecting", "正在连接 QQ 网关")
            try:
                await self.connect_once()
                delay = 1.0
                self.on_status("connecting", "服务端要求重连")
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
                self.handle_close(code)  # 致命错误会在这里抛出
                self.on_status("connecting", f"连接断开（{code}），{delay:.0f} 秒后重连")
            except FatalGatewayError:
                raise
            except Exception as exc:
                log.warning("网关连接出错：%s: %s", type(exc).__name__, exc)
                self.on_status("connecting", f"{type(exc).__name__}: {exc}，{delay:.0f} 秒后重连")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)
