import sqlite3

import pytest

from minddock.db import connect, migrate, now_iso


def test_migrate_creates_schema_and_is_idempotent(tmp_path):
    conn = connect(tmp_path / "t.db")

    assert migrate(conn) == 1
    assert migrate(conn) == 1

    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"items", "files", "todos", "reminders", "secrets", "jobs", "events"} <= tables


def test_partition_constraint_rejects_secret_items(tmp_path):
    conn = connect(tmp_path / "t.db")
    migrate(conn)
    now = now_iso()

    insert = (
        "INSERT INTO items (id, short_code, source, kind, partition, created_at, updated_at) "
        "VALUES (?, ?, 'qq', 'text', ?, ?, ?)"
    )
    conn.execute(insert, ("01A", "A001", "note", now, now))
    # 密钥只能进 secrets 表，items 不接受 secret 分区
    with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
        conn.execute(insert, ("01B", "A002", "secret", now, now))


def test_trigram_search_matches_chinese_substring(tmp_path):
    conn = connect(tmp_path / "t.db")
    migrate(conn)
    conn.execute(
        "INSERT INTO search_fts (item_id, body) VALUES (?, ?)", ("01A", "明天下午三点提醒我交报告")
    )

    hits = conn.execute("SELECT item_id FROM search_fts WHERE search_fts MATCH ?", ("交报告",))
    assert [r[0] for r in hits] == ["01A"]
