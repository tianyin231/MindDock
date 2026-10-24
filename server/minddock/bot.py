"""常驻 QQ 连接：绑定主人、收消息、回执、命令。

只处理已绑定主人发来的消息；绑定前，只有发对面板上绑定码的人才能成为主人。
"""

import asyncio
import contextlib
import logging
import re
import secrets
import sqlite3
from typing import Any

import httpx2

from minddock.commands import handle_command
from minddock.config import Settings
from minddock.db import now_iso
from minddock.ingest import Incoming, IncomingAttachment, ingest
from minddock.qq.api import QQApi, QQError
from minddock.qq.gateway import Gateway
from minddock.qq.replies import next_reply_seq, record_inbound
from minddock.secret_rules import detect_secret
from minddock.settings_store import SettingsStore
from minddock.util import emit, kv_delete, kv_get, kv_set

log = logging.getLogger(__name__)

STATUS_KEY = "qq.status"
OWNER_KEY = "qq.owner"
BIND_KEY = "qq.bind"
BIND_RE = re.compile(r"^(?:绑定\s*)?(\d{6})$")
MAX_BIND_ATTEMPTS = 5


def parse_c2c(data: dict[str, Any]) -> Incoming:
    author = data.get("author") or {}
    attachments = [
        IncomingAttachment(
            url=a["url"] if not a["url"].startswith("//") else "https:" + a["url"],
            filename=a.get("filename") or "",
            content_type=a.get("content_type") or "",
            size=a.get("size"),
            width=a.get("width"),
            height=a.get("height"),
        )
        for a in data.get("attachments") or []
        if a.get("url")
    ]
    return Incoming(
        msg_id=data["id"],
        openid=author.get("user_openid") or author.get("id") or "",
        content=data.get("content") or "",
        attachments=attachments,
    )


class Bot:
    def __init__(
        self,
        conn: sqlite3.Connection,
        store: SettingsStore,
        http: httpx2.AsyncClient,
        config: Settings,
    ):
        self.conn = conn
        self.store = store
        self.http = http
        self.config = config
        self.api: QQApi | None = None

    # ---- 状态 ----

    def set_status(self, state: str, detail: str) -> None:
        previous = kv_get(self.conn, STATUS_KEY) or {}
        if previous.get("state") != state:
            log.info("QQ 连接状态：%s（%s）", state, detail)
        kv_set(self.conn, STATUS_KEY, {"state": state, "detail": detail, "updated_at": now_iso()})

    def _touch_status(self) -> None:
        status = kv_get(self.conn, STATUS_KEY) or {"state": "connecting", "detail": ""}
        kv_set(self.conn, STATUS_KEY, {**status, "updated_at": now_iso()})

    async def _wait_for_change(self, version: str | None) -> None:
        while self.store.version("qq") == version:
            await asyncio.sleep(5)
            self._touch_status()

    # ---- 主循环：设置变化时用新凭据重连 ----

    async def run(self) -> None:
        while True:
            version = self.store.version("qq")
            if not self.store.configured("qq"):
                self.set_status("unconfigured", "尚未填写 QQ 机器人设置")
                await self._wait_for_change(version)
                continue

            cfg = self.store.get("qq")
            self.api = QQApi(cfg["app_id"], cfg["app_secret"], bool(cfg.get("sandbox")), self.http)
            task = asyncio.create_task(
                Gateway(self.api, self.on_dispatch, self.set_status).run_forever()
            )
            try:
                while not task.done() and self.store.version("qq") == version:
                    await asyncio.sleep(5)
                    self._touch_status()
                if task.done() and not task.cancelled() and task.exception():
                    self.set_status("error", str(task.exception()))
                    await self._wait_for_change(version)
            finally:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task

    # ---- 事件 ----

    async def on_dispatch(self, event: str, data: dict[str, Any]) -> None:
        if event == "C2C_MESSAGE_CREATE":
            await self.on_c2c(parse_c2c(data))
        else:
            log.debug("忽略事件 %s", event)

    async def reply(self, msg: Incoming, text: str) -> None:
        if self.api is None:
            return
        # 主人的消息由数据库分配 msg_seq（worker 也会回复同一条）；未绑定者的消息只回复一次
        seq = next_reply_seq(self.conn, msg.msg_id) or 1
        try:
            await self.api.send_c2c(msg.openid, text, msg.msg_id, seq)
        except (QQError, httpx2.HTTPError) as exc:
            log.warning("回复失败：%s", exc)

    async def on_c2c(self, msg: Incoming) -> None:
        owner = kv_get(self.conn, OWNER_KEY)
        if owner is None:
            await self._try_bind(msg)
            return
        if msg.openid != owner["openid"]:
            log.info("忽略未绑定用户的消息")
            return
        record_inbound(self.conn, msg.msg_id)

        text = msg.content.strip()
        if text.startswith("/"):
            await self.reply(msg, handle_command(self.conn, text, self.config.tz))
            return

        # 密钥在任何内容落盘之前分流；密钥库上线前不保存，提醒撤回
        reason = detect_secret(text)
        if reason:
            await self.reply(
                msg,
                f"🔒 这条消息{reason}，已按密钥处理：密钥库将在下一个版本上线，这条没有保存。"
                "建议在 2 分钟内撤回原消息。",
            )
            return

        result = ingest(self.conn, msg)
        if result is None:
            return
        tail = "，正在整理" if result.organizing else "，按要求不交给 AI 整理"
        await self.reply(msg, f"✅ #{result.code} 已收：{result.summary}{tail}")

    async def _try_bind(self, msg: Incoming) -> None:
        match = BIND_RE.match(msg.content.strip())
        bind = kv_get(self.conn, BIND_KEY)
        if not match:
            await self.reply(
                msg,
                "这是 MindDock 私人机器人，还没有绑定主人。"
                "请在面板「设置 → QQ 机器人」生成绑定码，然后发送：绑定 123456",
            )
            return
        if not bind or bind["expires_at"] <= now_iso():
            await self.reply(msg, "绑定码已过期或不存在，请在面板重新生成")
            return
        if not secrets.compare_digest(match.group(1), bind["code"]):
            bind["attempts"] = bind.get("attempts", 0) + 1
            if bind["attempts"] >= MAX_BIND_ATTEMPTS:
                kv_delete(self.conn, BIND_KEY)
            else:
                kv_set(self.conn, BIND_KEY, bind)
            await self.reply(msg, "绑定码不正确")
            return

        kv_set(self.conn, OWNER_KEY, {"openid": msg.openid, "bound_at": now_iso()})
        kv_delete(self.conn, BIND_KEY)
        record_inbound(self.conn, msg.msg_id)
        emit(self.conn, "qq.bound", {})
        log.info("已绑定主人")
        await self.reply(
            msg,
            "✅ 绑定成功！之后发给我的文字、链接、图片和文件都会自动整理到 MindDock。发送 /help 查看用法。",
        )
