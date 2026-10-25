"""备份接口：状态与本地备份列表、立即备份（交给 worker 执行）、下载加密的备份文件。"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse

from minddock import backup, backup_runner
from minddock.api.deps import client_ip, get_db, require_user
from minddock.jobs import enqueue
from minddock.util import audit

router = APIRouter(prefix="/api/backups", tags=["backups"], dependencies=[Depends(require_user)])


@router.get("")
async def overview(request: Request) -> dict:
    db = get_db(request)
    config = request.app.state.config
    state = backup.status(db)
    running = db.execute(
        "SELECT 1 FROM jobs WHERE type = 'backup' AND status IN ('queued', 'running')"
    ).fetchone()
    return {
        "configured": bool(config.backup_recipient),
        "schedule": backup_runner.SCHEDULE.strftime("%H:%M"),
        "keepLocal": config.backup_keep_local,
        "running": running is not None,
        "ok": state.get("ok"),
        "error": state.get("error"),
        "failedAt": state.get("failedAt"),
        "last": state.get("last"),
        "remote": state.get("remote"),
        "local": backup.list_local(config.data_dir),
    }


@router.post("")
async def backup_now(request: Request) -> dict:
    if not request.app.state.config.backup_recipient:
        raise HTTPException(
            status_code=409,
            detail="还没有备份密钥：在服务器上运行 bash /opt/minddock/deploy/backup.sh 生成",
        )
    enqueue(get_db(request), "backup", "manual")
    return {"queued": True}


@router.get("/{name}")
async def download(name: str, request: Request) -> FileResponse:
    path = backup.local_path(request.app.state.config.data_dir, name)
    if path is None:
        raise HTTPException(status_code=404, detail="备份不存在")
    audit(get_db(request), "backup_download", name, client_ip(request))
    return FileResponse(path, media_type="application/octet-stream", filename=name)
