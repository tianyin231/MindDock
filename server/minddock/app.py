"""面板服务：JSON 接口，以及前端构建产物的托管。"""

from contextlib import asynccontextmanager
from pathlib import Path

import httpx2
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from minddock import __version__
from minddock.api import auth, settings
from minddock.config import Settings, get_settings
from minddock.db import connect, migrate
from minddock.security import load_cipher

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def create_app(config: Settings | None = None) -> FastAPI:
    config = config or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = connect(config.db_path)
        migrate(conn)
        app.state.db = conn
        app.state.config = config
        app.state.cipher = load_cipher(config.secret_key, config.data_dir)
        app.state.auth = auth.init_auth_state(conn)
        async with httpx2.AsyncClient(timeout=20, follow_redirects=True) as http:
            app.state.http = http
            try:
                yield
            finally:
                conn.close()

    app = FastAPI(
        title="MindDock", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None
    )

    @app.middleware("http")
    async def csrf_guard(request: Request, call_next):
        # 修改类请求必须带自定义头：跨站页面无法在不触发预检的情况下加上它，
        # 配合 SameSite Cookie 防 CSRF
        if (
            request.method in UNSAFE_METHODS
            and request.url.path.startswith("/api/")
            and request.headers.get("x-minddock") != "1"
        ):
            return JSONResponse({"detail": "请求缺少校验头"}, status_code=403)
        return await call_next(request)

    # 接口和依赖都写成 async：共享的 SQLite 连接只在事件循环线程上使用
    @app.get("/api/health")
    async def health() -> dict:
        schema = app.state.db.execute("PRAGMA user_version").fetchone()[0]
        return {
            "status": "ok",
            "version": __version__,
            "build": config.version,
            "commit": config.commit[:7],
            "schema": schema,
        }

    app.include_router(auth.router)
    app.include_router(settings.router)
    _mount_web(app, config.web_dist_dir)
    return app


def _mount_web(app: FastAPI, dist: Path) -> None:
    """托管单页应用：静态资源直接返回，其余非接口路径回退到 index.html。"""
    index = dist / "index.html"
    if not index.is_file():
        return

    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> FileResponse:
        if path.startswith("api/"):
            raise HTTPException(status_code=404)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(dist.resolve()):
            return FileResponse(candidate)
        # index.html 不缓存，保证更新版本后浏览器拿到新的资源清单
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
