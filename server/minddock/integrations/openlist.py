"""OpenList 管理接口：用面板里填的夸克 Cookie 挂载存储，并读写文件。"""

import json
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx2

QUARK_MOUNT = "/quark"
UPLOAD_CHUNK = 1024 * 1024
RELOGIN_SECONDS = 12 * 3600


class OpenListError(RuntimeError):
    pass


# 夸克 Cookie 失效（被退出登录、改密码等）时，夸克接口返回 "require login [guest]"，错误码 31001
QUARK_LOGGED_OUT = "Cookie 已失效（被退出登录或过期），请重新登录夸克网页版并复制新的 Cookie"


def quark_logged_out(message: str) -> bool:
    text = message.lower()
    return "require login" in text or "31001" in text


class OpenListClient:
    def __init__(
        self, base_url: str, password: str, http: httpx2.AsyncClient, username: str = "admin"
    ):
        self._base = base_url.rstrip("/")
        self._username = username
        self._password = password
        self._http = http
        self._token: str | None = None
        self._logged_in = 0.0

    async def _call(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = kwargs.pop("headers", {})
        if self._token:
            headers["Authorization"] = self._token
        try:
            resp = await self._http.request(method, self._base + path, headers=headers, **kwargs)
        except httpx2.HTTPError as exc:
            raise OpenListError(f"无法连接 OpenList：{exc}") from exc
        try:
            body = resp.json()
        except ValueError:
            raise OpenListError(f"OpenList 返回了非 JSON 响应（HTTP {resp.status_code}）") from None
        # 登录令牌过期：重新登录后重试一次（流式上传的内容无法重放，由调用方重试）
        content = kwargs.get("content")
        if (
            body.get("code") == 401
            and self._token
            and (content is None or isinstance(content, bytes))
        ):
            await self.login()
            headers["Authorization"] = self._token
            return await self._call(method, path, headers=headers, **kwargs)
        if body.get("code") != 200:
            raise OpenListError(body.get("message") or f"OpenList 返回错误码 {body.get('code')}")
        return body.get("data")

    async def login(self) -> None:
        if not self._password:
            raise OpenListError("未配置 OpenList 管理员密码（MINDDOCK_OPENLIST_ADMIN_PASSWORD）")
        self._token = None
        data = await self._call(
            "POST", "/api/auth/login", json={"username": self._username, "password": self._password}
        )
        self._token = data["token"]
        self._logged_in = time.monotonic()

    async def ensure_login(self) -> None:
        """长期运行的进程里，令牌接近过期前主动重新登录（OpenList 默认 48 小时过期）。"""
        if self._token is None or time.monotonic() - self._logged_in > RELOGIN_SECONDS:
            await self.login()

    async def ensure_quark(self, cookie: str) -> dict[str, Any]:
        """创建或更新夸克存储，返回存储信息；Cookie 无效时 OpenList 会把原因写在 status 里。"""
        existing = await self._find_storage(QUARK_MOUNT)
        body: dict[str, Any] = {
            "mount_path": QUARK_MOUNT,
            "driver": "Quark",
            "order": 0,
            "remark": "由 MindDock 管理，请在 MindDock 面板中修改",
            "cache_expiration": 30,
            "web_proxy": True,
            "webdav_policy": "native_proxy",
            "down_proxy_url": "",
            "addition": json.dumps(
                {
                    "cookie": cookie,
                    "root_folder_id": "0",
                    "order_by": "none",
                    "order_direction": "asc",
                }
            ),
        }
        if existing:
            body = {**existing, **body}
            await self._call("POST", "/api/admin/storage/update", json=body)
        else:
            await self._call("POST", "/api/admin/storage/create", json=body)
        storage = await self._find_storage(QUARK_MOUNT)
        if storage is None:
            raise OpenListError("夸克存储创建后未找到")
        return storage

    async def _find_storage(self, mount_path: str) -> dict[str, Any] | None:
        data = await self._call(
            "GET", "/api/admin/storage/list", params={"page": 1, "per_page": 100}
        )
        return next(
            (s for s in data.get("content") or [] if s.get("mount_path") == mount_path), None
        )

    async def list_dir(self, path: str) -> list[dict[str, Any]]:
        data = await self._call(
            "POST",
            "/api/fs/list",
            json={"path": path, "password": "", "page": 1, "per_page": 0, "refresh": True},
        )
        return data.get("content") or []

    async def mkdir(self, path: str) -> None:
        await self._call("POST", "/api/fs/mkdir", json={"path": path})

    async def put(self, path: str, content: bytes) -> None:
        await self._call(
            "PUT",
            "/api/fs/put",
            content=content,
            headers={"File-Path": quote(path), "Content-Type": "application/octet-stream"},
        )

    async def remove(self, directory: str, names: list[str]) -> None:
        await self._call("POST", "/api/fs/remove", json={"dir": directory, "names": names})

    async def put_file(self, path: str, local: Path, size: int) -> None:
        """流式上传本地文件：边读边发，不整个读进内存；同名文件会被覆盖。"""

        async def chunks():
            with local.open("rb") as fh:
                while chunk := fh.read(UPLOAD_CHUNK):
                    yield chunk

        await self._call(
            "PUT",
            "/api/fs/put",
            content=chunks(),
            headers={
                "File-Path": quote(path),
                "Content-Type": "application/octet-stream",
                "Content-Length": str(size),
                "As-Task": "false",
            },
            # OpenList 要把整个文件转存到夸克后才返回，大文件需要很久
            timeout=httpx2.Timeout(30, read=None, write=600),
        )

    async def stat(self, path: str) -> dict[str, Any] | None:
        """文件信息，含带签名的 raw_url（经 OpenList 代理下载，支持 Range）；不存在时返回 None。"""
        try:
            return await self._call("POST", "/api/fs/get", json={"path": path, "password": ""})
        except OpenListError as exc:
            if "not found" in str(exc).lower():
                return None
            raise

    async def storage_status(self) -> str | None:
        storage = await self._find_storage(QUARK_MOUNT)
        return storage.get("status") if storage else None
