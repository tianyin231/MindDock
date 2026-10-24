"""后台任务队列：SQLite jobs 表。

同一对象的同类任务只保留一个活动任务（见 jobs_active 唯一索引）；失败按退避间隔重试，
超过次数进入 dead，可在面板手动重试。
"""

import sqlite3
from dataclasses import dataclass

from minddock.db import now_iso

# 第 n 次失败后等待的秒数；超出列表长度后每 12 小时重试一次，直到达到上限
BACKOFF = [60, 300, 1800, 7200, 21600]
MAX_ATTEMPTS = 8
STALE_SECONDS = 600


@dataclass(frozen=True)
class Job:
    id: int
    type: str
    ref_id: str
    attempts: int


def enqueue(conn: sqlite3.Connection, job_type: str, ref_id: str, delay: int = 0) -> None:
    now = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO jobs (type, ref_id, status, run_after, created_at, updated_at) "
        "VALUES (?, ?, 'queued', ?, ?, ?)",
        (job_type, ref_id, now_iso(delay), now, now),
    )


def claim(
    conn: sqlite3.Connection, *, only: tuple[str, ...] = (), exclude: tuple[str, ...] = ()
) -> Job | None:
    """取一个到期的任务；only / exclude 按类型筛选（上传由单独的消费者处理，不占用其他任务）。"""
    now = now_iso()
    where, args = "", []
    if only:
        where += f" AND type IN ({','.join('?' * len(only))})"
        args += only
    if exclude:
        where += f" AND type NOT IN ({','.join('?' * len(exclude))})"
        args += exclude
    # 用 fetchall 读完 RETURNING 的结果，语句才算执行完毕并释放写锁
    rows = conn.execute(
        "UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1, updated_at = ? "
        "WHERE id = (SELECT id FROM jobs WHERE status IN ('queued', 'failed') AND run_after <= ?"
        f"{where} ORDER BY run_after, id LIMIT 1) RETURNING id, type, ref_id, attempts",
        (now, now, now, *args),
    ).fetchall()
    if not rows:
        return None
    row = rows[0]
    return Job(row["id"], row["type"], row["ref_id"], row["attempts"])


def complete(conn: sqlite3.Connection, job: Job) -> None:
    conn.execute(
        "UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?",
        (now_iso(), job.id),
    )


def fail(conn: sqlite3.Connection, job: Job, error: str) -> str:
    """记录失败并安排重试，返回新状态。"""
    if job.attempts >= MAX_ATTEMPTS:
        status, run_after = "dead", now_iso()
    else:
        delay = BACKOFF[job.attempts - 1] if job.attempts <= len(BACKOFF) else 43200
        status, run_after = "failed", now_iso(delay)
    conn.execute(
        "UPDATE jobs SET status = ?, run_after = ?, last_error = ?, updated_at = ? WHERE id = ?",
        (status, run_after, error[:500], now_iso(), job.id),
    )
    return status


def retry_now(conn: sqlite3.Connection, job_type: str, ref_id: str) -> None:
    """面板手动重试：已有失败任务就立即重排，否则新建一个。"""
    cur = conn.execute(
        "UPDATE jobs SET status = 'queued', run_after = ?, attempts = 0, updated_at = ? "
        "WHERE type = ? AND ref_id = ? AND status IN ('failed', 'queued')",
        (now_iso(), now_iso(), job_type, ref_id),
    )
    if cur.rowcount == 0:
        enqueue(conn, job_type, ref_id)


def requeue_stale(conn: sqlite3.Connection) -> int:
    """进程重启后，把卡在 running 的任务放回队列。"""
    cur = conn.execute(
        "UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running' AND locked_at < ?",
        (now_iso(), now_iso(-STALE_SECONDS)),
    )
    return cur.rowcount
