"""面板可编辑的业务设置：QQ 机器人、AI 模型、夸克网盘、邮件通知。

每个分组整体存成 settings 表中的一行 JSON；密钥类字段先加密再存，接口只返回"是否已设置"和末尾几位。
"""

import json
import re
import secrets
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from minddock.db import now_iso
from minddock.security import Cipher

FieldKind = Literal["text", "secret", "number", "bool"]


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    kind: FieldKind = "text"
    required: bool = False
    default: Any = None
    placeholder: str = ""
    help: str = ""
    # 保存前整理并检查填写的值，不合格时抛出 SettingsError
    normalize: Callable[[str], str] | None = None


class SettingsError(ValueError):
    pass


def quark_cookie(value: str) -> str:
    """去掉从开发者工具连带复制的 "Cookie:" 前缀和换行，并确认带有登录凭据 __pus。

    实测夸克只认 __pus：__puus 每次请求都会换新、24 小时过期，缺了也会按 __pus 重新签发。
    """
    value = re.sub(r"^cookie\s*:\s*", "", value.strip(), flags=re.IGNORECASE)
    value = " ".join(value.split())
    if not re.search(r"(?:^|;)\s*__pus=[^;\s]", value):
        raise SettingsError(
            "Cookie 里没有登录凭据 __pus：请确认已登录夸克网页版，"
            "并复制 drive-pc.quark.cn 请求里完整的 Cookie"
        )
    return value


@dataclass(frozen=True)
class Section:
    key: str
    title: str
    description: str
    fields: tuple[Field, ...]


SECTIONS: dict[str, Section] = {
    s.key: s
    for s in (
        Section(
            "qq",
            "QQ 机器人",
            "在 QQ 开放平台创建的官方机器人，用来收消息、发回执和提醒",
            (
                Field("app_id", "AppID", required=True, placeholder="例如 102xxxxxx"),
                Field("app_secret", "AppSecret", "secret", required=True),
                Field(
                    "sandbox",
                    "使用沙箱环境",
                    "bool",
                    default=False,
                    help="机器人尚未上线、只在沙箱里使用时打开",
                ),
            ),
        ),
        Section(
            "ai",
            "AI 模型",
            "OpenAI 兼容接口，用于归类、摘要和解析提醒时间",
            (
                Field(
                    "base_url", "接口地址", required=True, placeholder="https://api.example.com/v1"
                ),
                Field("api_key", "API Key", "secret", required=True),
                Field("model_text", "文字模型", required=True, placeholder="例如 gpt-4o-mini"),
                Field(
                    "model_vision", "图片模型", placeholder="可留空", help="识别截图和图片内容用"
                ),
                Field("model_embed", "向量模型", placeholder="可留空", help="语义搜索用，后续启用"),
            ),
        ),
        Section(
            "storage",
            "夸克网盘",
            "原件归档位置，经内置的 OpenList 接入",
            (
                Field(
                    "quark_cookie",
                    "夸克 Cookie",
                    "secret",
                    required=True,
                    help=(
                        "建议在浏览器无痕窗口登录 pan.quark.cn，按 F12 在网络面板中找到"
                        " drive-pc.quark.cn 的请求，复制请求头里的 Cookie；复制后直接关闭窗口，"
                        "不要点退出登录，否则这份 Cookie 会失效"
                    ),
                    normalize=quark_cookie,
                ),
                Field("folder", "归档目录", default="MindDock", help="夸克根目录下的文件夹名"),
            ),
        ),
        Section(
            "notify",
            "邮件通知",
            "QQ 主动消息发送失败时，改发邮件提醒",
            (
                Field("smtp_host", "SMTP 服务器", required=True, placeholder="例如 smtp.163.com"),
                Field(
                    "smtp_port", "端口", "number", default=465, help="465 为 SSL，587 为 STARTTLS"
                ),
                Field("smtp_user", "发件邮箱", required=True),
                Field("smtp_password", "授权码", "secret", required=True),
                Field("to_email", "收件邮箱", required=True, placeholder="你的 QQ 邮箱"),
            ),
        ),
    )
}


def _row_key(section: str) -> str:
    return f"section:{section}"


class SettingsStore:
    def __init__(self, conn: sqlite3.Connection, cipher: Cipher):
        self._conn = conn
        self._cipher = cipher

    def _section(self, key: str) -> Section:
        if key not in SECTIONS:
            raise SettingsError(f"未知的设置分组：{key}")
        return SECTIONS[key]

    def _raw(self, key: str) -> dict[str, Any]:
        row = self._conn.execute(
            "SELECT value FROM settings WHERE key = ?", (_row_key(key),)
        ).fetchone()
        return json.loads(row[0]) if row else {}

    def get(self, key: str) -> dict[str, Any]:
        """内部使用：返回解密后的完整设置，未填写的字段取默认值。"""
        section, raw = self._section(key), self._raw(key)
        values: dict[str, Any] = {}
        for f in section.fields:
            value = raw.get(f.key, f.default)
            if f.kind == "secret" and value:
                value = self._cipher.decrypt(value)
            values[f.key] = value
        return values

    def version(self, key: str) -> str | None:
        """分组每次保存都会变的标记；常驻服务据此判断设置是否变化。
        时间只精确到秒，所以再带一个随机修订号，同一秒内保存两次也能区分。"""
        raw = self._raw(key)
        if "_updated_at" not in raw:
            return None
        return f"{raw['_updated_at']}/{raw.get('_rev', '')}"

    def configured(self, key: str) -> bool:
        values = self.get(key)
        return all(
            values.get(f.key) not in (None, "") for f in self._section(key).fields if f.required
        )

    def public(self, key: str) -> dict[str, Any]:
        """给面板看的版本：密钥字段只说明是否已设置，并给出末尾 4 位帮助辨认。"""
        section, raw = self._section(key), self._raw(key)
        values: dict[str, Any] = {}
        for f in section.fields:
            if f.kind == "secret":
                secret = self._cipher.decrypt(raw[f.key]) if raw.get(f.key) else ""
                values[f.key] = {
                    "set": bool(secret),
                    "hint": secret[-4:] if len(secret) >= 12 else "",
                }
            else:
                values[f.key] = raw.get(f.key, f.default)
        return {
            "key": section.key,
            "title": section.title,
            "description": section.description,
            "fields": [
                {
                    "key": f.key,
                    "label": f.label,
                    "kind": f.kind,
                    "required": f.required,
                    "placeholder": f.placeholder,
                    "help": f.help,
                }
                for f in section.fields
            ],
            "values": values,
            "configured": self.configured(key),
            "updated_at": raw.get("_updated_at"),
        }

    def update(self, key: str, changes: dict[str, Any]) -> None:
        """密钥字段：传字符串表示替换，传 null 表示清除，不传表示保持不变。"""
        section, raw = self._section(key), self._raw(key)
        fields = {f.key: f for f in section.fields}
        for name, value in changes.items():
            f = fields.get(name)
            if f is None:
                raise SettingsError(f"未知的设置项：{name}")
            raw[name] = self._coerce(f, value)
        raw["_updated_at"] = now_iso()
        raw["_rev"] = secrets.token_hex(4)
        self._conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (_row_key(key), json.dumps(raw, ensure_ascii=False)),
        )

    def _coerce(self, f: Field, value: Any) -> Any:
        if value is None:
            return None
        if f.kind == "secret":
            if not isinstance(value, str) or not value.strip():
                raise SettingsError(f"{f.label}不能为空")
            value = f.normalize(value) if f.normalize else value.strip()
            return self._cipher.encrypt(value)
        if f.kind == "bool":
            if not isinstance(value, bool):
                raise SettingsError(f"{f.label}必须是开关值")
            return value
        if f.kind == "number":
            try:
                return int(value)
            except (TypeError, ValueError):
                raise SettingsError(f"{f.label}必须是数字") from None
        if not isinstance(value, str):
            raise SettingsError(f"{f.label}必须是文本")
        return value.strip()
