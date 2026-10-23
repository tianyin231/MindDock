"""面板"测试连接"：逐项验证 QQ 机器人、AI 接口、夸克网盘和邮件是否可用。"""

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import httpx2

from minddock.integrations.email import send_email
from minddock.integrations.openlist import QUARK_MOUNT, OpenListClient, OpenListError

QQ_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken"
QQ_API = "https://api.sgroup.qq.com"
QQ_SANDBOX_API = "https://sandbox.api.sgroup.qq.com"


@dataclass
class ProbeResult:
    ok: bool
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def _ms(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


def _error_text(resp: httpx2.Response) -> str:
    try:
        body = resp.json()
    except ValueError:
        return f"HTTP {resp.status_code}"
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])
        for key in ("message", "msg", "detail"):
            if body.get(key):
                return str(body[key])
    return f"HTTP {resp.status_code}"


async def probe_qq(cfg: dict[str, Any], http: httpx2.AsyncClient) -> ProbeResult:
    start = time.perf_counter()
    resp = await http.post(
        QQ_TOKEN_URL, json={"appId": str(cfg["app_id"]), "clientSecret": cfg["app_secret"]}
    )
    token = resp.json().get("access_token") if resp.status_code == 200 else None
    if not token:
        return ProbeResult(False, f"获取 access_token 失败：{_error_text(resp)}")

    api = QQ_SANDBOX_API if cfg.get("sandbox") else QQ_API
    gw = await http.get(f"{api}/gateway", headers={"Authorization": f"QQBot {token}"})
    url = gw.json().get("url") if gw.status_code == 200 else None
    if not url:
        return ProbeResult(False, f"凭据有效，但获取网关地址失败：{_error_text(gw)}")
    return ProbeResult(True, "凭据有效，消息网关可连接", {"gateway": url, "latency_ms": _ms(start)})


async def probe_ai(cfg: dict[str, Any], http: httpx2.AsyncClient) -> ProbeResult:
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {cfg['api_key']}"}
    base = {"model": cfg["model_text"], "max_tokens": 32, "temperature": 0}

    start = time.perf_counter()
    resp = await http.post(
        url, headers=headers, json={**base, "messages": [{"role": "user", "content": "只回复 OK"}]}
    )
    if resp.status_code != 200 or not resp.json().get("choices"):
        return ProbeResult(False, f"调用 {cfg['model_text']} 失败：{_error_text(resp)}")
    latency = _ms(start)

    # 归类需要结构化输出：依次尝试 JSON Schema 和 JSON 模式，记录接口支持到哪一级
    schema = {
        "name": "probe",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"],
            "additionalProperties": False,
        },
    }
    structured = "none"
    for mode, fmt in (
        ("json_schema", {"type": "json_schema", "json_schema": schema}),
        ("json_object", {"type": "json_object"}),
    ):
        r = await http.post(
            url,
            headers=headers,
            json={
                **base,
                "messages": [{"role": "user", "content": '以 JSON 回复：{"ok": true}'}],
                "response_format": fmt,
            },
        )
        if r.status_code == 200 and r.json().get("choices"):
            structured = mode
            break

    label = {
        "json_schema": "支持 JSON Schema",
        "json_object": "支持 JSON 模式",
        "none": "不支持结构化输出",
    }
    return ProbeResult(
        True,
        f"{cfg['model_text']} 可用，{label[structured]}",
        {"latency_ms": latency, "structured_output": structured},
    )


async def probe_storage(cfg: dict[str, Any], openlist: OpenListClient) -> ProbeResult:
    try:
        await openlist.login()
        storage = await openlist.ensure_quark(cfg["quark_cookie"])
        if storage.get("status") != "work":
            return ProbeResult(False, f"夸克挂载失败：{storage.get('status') or '未知原因'}")

        folder = (cfg.get("folder") or "MindDock").strip("/")
        root = f"{QUARK_MOUNT}/{folder}"
        if folder not in {e["name"] for e in await openlist.list_dir(QUARK_MOUNT)}:
            await openlist.mkdir(root)

        name = ".minddock-probe.txt"
        payload = f"MindDock 连通性测试 {time.time():.0f}".encode()
        start = time.perf_counter()
        await openlist.put(f"{root}/{name}", payload)
        upload_ms = _ms(start)
        entries = await openlist.list_dir(root)
        found = any(e["name"] == name and e.get("size") == len(payload) for e in entries)
        await openlist.remove(root, [name])
    except OpenListError as exc:
        return ProbeResult(False, str(exc))

    if not found:
        return ProbeResult(False, "测试文件上传后未在夸克中找到")
    return ProbeResult(True, f"夸克已挂载，「{folder}」目录读写正常", {"upload_ms": upload_ms})


async def probe_notify(cfg: dict[str, Any]) -> ProbeResult:
    try:
        await asyncio.to_thread(
            send_email,
            cfg,
            "MindDock 测试邮件",
            "收到这封邮件，说明 MindDock 的邮件提醒渠道已配置成功。",
        )
    except Exception as exc:  # smtplib 的异常类型很多，这里统一转成提示
        return ProbeResult(False, f"发送失败：{exc}")
    return ProbeResult(True, f"测试邮件已发送到 {cfg['to_email']}")
