"""抓取消息里的网页：标题、站点、正文摘录，给 AI 归类和全文搜索用。"""

import asyncio
import ipaddress
import json
import re
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx2

MAX_BYTES = 2_000_000
UA = "Mozilla/5.0 (compatible; MindDock/0.1; +https://github.com/tianyin231/MindDock)"
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


@dataclass
class Page:
    final_url: str
    site: str
    title: str | None
    text: str | None


def is_public_url(url: str) -> bool:
    """只抓公网地址：不访问本机、内网和容器内部服务名。"""
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https") or not host or "." not in host:
        return False
    if host == "localhost" or host.endswith((".local", ".internal")):
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return True
    return ip.is_global


async def fetch_page(http: httpx2.AsyncClient, url: str) -> Page:
    if not is_public_url(url):
        raise ValueError("不抓取内网或本机地址")
    chunks, size = [], 0
    async with http.stream(
        "GET", url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"}, timeout=15
    ) as resp:
        resp.raise_for_status()
        content_type = resp.headers.get("content-type", "")
        final_url = str(resp.url)
        async for chunk in resp.aiter_bytes():
            chunks.append(chunk)
            size += len(chunk)
            if size >= MAX_BYTES:
                break
        encoding = resp.encoding or "utf-8"

    site = (urlparse(final_url).hostname or "").removeprefix("www.")
    if "html" not in content_type:
        return Page(final_url, site, None, None)
    html = b"".join(chunks).decode(encoding, errors="replace")
    title, text = await asyncio.to_thread(_extract, html, final_url)
    return Page(final_url, site, title, text)


def _extract(html: str, url: str) -> tuple[str | None, str | None]:
    import trafilatura

    title = text = None
    raw = trafilatura.extract(html, url=url, output_format="json", with_metadata=True)
    if raw:
        data = json.loads(raw)
        title, text = data.get("title"), data.get("text")
    if not title:
        match = _TITLE_RE.search(html)
        title = re.sub(r"\s+", " ", match.group(1)).strip() if match else None
    return title, text
