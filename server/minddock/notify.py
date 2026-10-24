"""给主人发消息：被动回复优先，其次 QQ 主动消息，最后邮件。

QQ 官方机器人的被动回复只能在收到消息后 60 分钟内发送，同一消息最多 5 次；主动消息额度很少，
可能随时失败。所以先找一条还能回复的消息（指定的原消息，或主人最近发来的消息），找不到再发主动消息。
"""

import asyncio
import logging
import sqlite3
from dataclasses import dataclass, field

import httpx2

from minddock.bot import OWNER_KEY
from minddock.integrations.email import send_email
from minddock.qq.api import QQApi, QQError
from minddock.qq.replies import latest_inbound, next_reply_seq
from minddock.settings_store import SettingsStore
from minddock.util import kv_get

log = logging.getLogger(__name__)


@dataclass
class Delivery:
    channel: str | None  # qq | email；None 表示所有渠道都失败
    errors: list[str] = field(default_factory=list)


class Notifier:
    def __init__(self, conn: sqlite3.Connection, store: SettingsStore, http: httpx2.AsyncClient):
        self.conn = conn
        self.store = store
        self.http = http
        self._qq: QQApi | None = None
        self._qq_version: str | None = None

    def qq(self) -> QQApi | None:
        if not self.store.configured("qq"):
            return None
        version = self.store.version("qq")
        if self._qq is None or version != self._qq_version:
            cfg = self.store.get("qq")
            self._qq = QQApi(cfg["app_id"], cfg["app_secret"], bool(cfg.get("sandbox")), self.http)
            self._qq_version = version
        return self._qq

    async def send(
        self,
        text: str,
        *,
        reply_to: str | None = None,
        email_subject: str | None = None,
        email_body: str | None = None,
    ) -> Delivery:
        """reply_to：优先回复的原消息；email_subject：给出时，QQ 发不出去会改发邮件。"""
        errors: list[str] = []
        api, owner = self.qq(), kv_get(self.conn, OWNER_KEY)
        if api is None or owner is None:
            errors.append("QQ 机器人未配置或未绑定主人")
        else:
            for msg_id in dict.fromkeys(m for m in (reply_to, latest_inbound(self.conn)) if m):
                seq = next_reply_seq(self.conn, msg_id)
                if seq is None:
                    continue
                try:
                    await api.send_c2c(owner["openid"], text, msg_id, seq)
                    return Delivery("qq", errors)
                except (QQError, httpx2.HTTPError) as exc:
                    errors.append(f"QQ 被动回复：{exc}")
            try:
                await api.send_c2c(owner["openid"], text)
                return Delivery("qq", errors)
            except (QQError, httpx2.HTTPError) as exc:
                errors.append(f"QQ 主动消息：{exc}")

        if email_subject and self.store.configured("notify"):
            try:
                await asyncio.to_thread(
                    send_email, self.store.get("notify"), email_subject, email_body or text
                )
                return Delivery("email", errors)
            except Exception as exc:  # smtplib 的异常类型很多，统一记录
                errors.append(f"邮件：{exc}")
        elif email_subject:
            errors.append("邮件通知未配置")
        for error in errors:
            log.warning("消息发送失败：%s", error)
        return Delivery(None, errors)
