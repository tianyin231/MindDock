"""原件归档接口：存储状态、单个文件重新上传、失败的全部重试。"""

from fastapi import APIRouter, Depends, HTTPException, Request

from minddock import storage
from minddock.api.deps import get_db, require_user
from minddock.items import item_to_api
from minddock.settings_store import SettingsStore

router = APIRouter(prefix="/api", tags=["storage"], dependencies=[Depends(require_user)])


@router.get("/storage")
async def storage_state(request: Request) -> dict:
    db = get_db(request)
    config = request.app.state.config
    return {
        "configured": SettingsStore(db, request.app.state.cipher).configured("storage"),
        "health": storage.health(db),
        "keepDays": config.staging_keep_days,
        **storage.stats(db, config.data_dir),
    }


@router.post("/storage/retry")
async def retry_failed(request: Request) -> dict:
    db = get_db(request)
    return {"requeued": storage.retry_failed(db) + storage.enqueue_pending(db)}


@router.post("/files/{file_id}/upload")
async def retry_upload(file_id: str, request: Request) -> dict:
    db = get_db(request)
    row = db.execute("SELECT item_id, local_path FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="附件不存在")
    if not row["local_path"]:
        raise HTTPException(status_code=409, detail="原件还没下载完成")
    storage.retry_upload(db, file_id)
    return item_to_api(db, row["item_id"])
