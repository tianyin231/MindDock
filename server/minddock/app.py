"""面板服务：JSON 接口，以及前端构建产物的托管。"""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from minddock import __version__
from minddock.config import Settings, get_settings
from minddock.db import connect, migrate


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = connect(settings.db_path)
        migrate(conn)
        app.state.db = conn
        try:
            yield
        finally:
            conn.close()

    app = FastAPI(title="MindDock", version=__version__, lifespan=lifespan, docs_url=None)

    @app.get("/api/health")
    def health() -> dict:
        schema = app.state.db.execute("PRAGMA user_version").fetchone()[0]
        return {"status": "ok", "version": __version__, "schema": schema}

    _mount_web(app, settings.web_dist_dir)
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
        return FileResponse(index)
