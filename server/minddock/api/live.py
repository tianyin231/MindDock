"""实时事件（SSE）：把 bot / worker 写入 events 表的事件推给浏览器。"""

import asyncio
import json

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from minddock.api.deps import get_db, require_user

router = APIRouter(prefix="/api", tags=["live"], dependencies=[Depends(require_user)])

POLL_SECONDS = 1.0
KEEPALIVE_SECONDS = 20


@router.get("/events")
async def events(request: Request) -> StreamingResponse:
    db = get_db(request)
    header = request.headers.get("last-event-id", "")
    # 断线重连时从上次收到的事件继续；首次连接只推之后的新事件
    last = (
        int(header)
        if header.isdigit()
        else db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]
    )

    async def stream():
        nonlocal last
        yield "retry: 3000\n\n"
        idle = 0.0
        while not await request.is_disconnected():
            rows = db.execute(
                "SELECT id, type, payload FROM events WHERE id > ? ORDER BY id LIMIT 100", (last,)
            ).fetchall()
            for row in rows:
                last = row["id"]
                data = {"type": row["type"], **json.loads(row["payload"])}
                yield f"id: {row['id']}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
            if rows:
                idle = 0.0
                continue
            idle += POLL_SECONDS
            if idle >= KEEPALIVE_SECONDS:
                idle = 0.0
                yield ": keepalive\n\n"
            await asyncio.sleep(POLL_SECONDS)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
