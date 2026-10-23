-- MindDock 初始结构。时间统一为 UTC ISO 8601 文本，例如 2026-10-23T07:30:12Z。

-- 条目：每条 QQ 消息或每次面板上传对应一条（密钥除外，见 secrets）
CREATE TABLE items (
    id               TEXT PRIMARY KEY,                  -- ULID
    short_code       TEXT NOT NULL UNIQUE,              -- 回执中的 #A3F9
    source           TEXT NOT NULL CHECK (source IN ('qq', 'panel')),
    source_msg_id    TEXT UNIQUE,                       -- QQ 消息 ID，用于去重
    kind             TEXT NOT NULL CHECK (kind IN ('text', 'link', 'media', 'mixed')),
    partition        TEXT NOT NULL DEFAULT 'inbox'
                     CHECK (partition IN ('inbox', 'note', 'bookmark', 'todo', 'reminder', 'file')),
    partition_source TEXT NOT NULL DEFAULT 'auto' CHECK (partition_source IN ('auto', 'user')),
    text             TEXT NOT NULL DEFAULT '',          -- 当前正文
    user_title       TEXT,                              -- 手动标题，优先于 AI
    user_tags        TEXT NOT NULL DEFAULT '[]',        -- JSON 数组，用户标签
    no_ai            INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trashed')),
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    trashed_at       TEXT
);
CREATE INDEX items_partition ON items (status, partition, created_at DESC);
CREATE INDEX items_created ON items (status, created_at DESC);

-- 正文修订历史，第一条即原始消息
CREATE TABLE item_revisions (
    id         INTEGER PRIMARY KEY,
    item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX item_revisions_item ON item_revisions (item_id, id);

CREATE TABLE files (
    id            TEXT PRIMARY KEY,
    item_id       TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    sha256        TEXT,                                  -- 下载完成前为空
    size          INTEGER,
    mime          TEXT,
    original_name TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'file')),
    meta          TEXT NOT NULL DEFAULT '{}',            -- 宽高、时长等
    local_path    TEXT,
    thumb_path    TEXT,
    backend       TEXT,                                  -- quark | r2 | local
    remote_path   TEXT,
    upload_status TEXT NOT NULL DEFAULT 'pending'
                  CHECK (upload_status IN ('pending', 'uploading', 'uploaded', 'failed')),
    uploaded_at   TEXT,
    created_at    TEXT NOT NULL
);
CREATE INDEX files_item ON files (item_id);
CREATE INDEX files_upload ON files (upload_status);
CREATE INDEX files_sha256 ON files (sha256);

CREATE TABLE links (
    id           INTEGER PRIMARY KEY,
    item_id      TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    final_url    TEXT,
    title        TEXT,
    site         TEXT,
    content_text TEXT,
    fetch_status TEXT NOT NULL DEFAULT 'pending' CHECK (fetch_status IN ('pending', 'ok', 'failed')),
    fetched_at   TEXT
);
CREATE INDEX links_item ON links (item_id);

-- AI 结果，与原文分开保存
CREATE TABLE derived (
    item_id        TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    partition      TEXT,
    title          TEXT,
    summary        TEXT,
    tags           TEXT NOT NULL DEFAULT '[]',
    ocr_text       TEXT,
    model          TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE todos (
    item_id TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    due_at  TEXT,
    done_at TEXT
);
CREATE INDEX todos_open ON todos (done_at, due_at);

CREATE TABLE reminders (
    id         TEXT PRIMARY KEY,
    item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    remind_at  TEXT NOT NULL,
    repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
    status     TEXT NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'sent', 'failed', 'cancelled')),
    channel    TEXT,                                     -- qq | email
    sent_at    TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX reminders_due ON reminders (status, remind_at);

-- 密钥：只存公钥加密后的密文
CREATE TABLE secrets (
    id            TEXT PRIMARY KEY,
    short_code    TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL CHECK (kind IN ('text', 'file')),
    sealed        BLOB,                                  -- 文本密钥的密文
    blob_path     TEXT,                                  -- 文件密钥的密文路径
    original_name TEXT,
    size          INTEGER,
    source_msg_id TEXT UNIQUE,
    created_at    TEXT NOT NULL,
    trashed_at    TEXT
);

CREATE TABLE vault_keys (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    public_key    BLOB NOT NULL,
    sk_wrapped_pw BLOB NOT NULL,                         -- 用二级密码包裹的私钥
    pw_salt       BLOB NOT NULL,
    pw_params     TEXT NOT NULL,                         -- Argon2id 参数，JSON
    sk_wrapped_rc BLOB NOT NULL,                         -- 用恢复码包裹的私钥
    rc_salt       BLOB NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL,
    ref_id     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'running', 'done', 'failed', 'dead')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    run_after  TEXT NOT NULL,
    locked_at  TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX jobs_ready ON jobs (status, run_after);
-- 同一对象的同类任务只保留一个活动任务
CREATE UNIQUE INDEX jobs_active ON jobs (type, ref_id) WHERE status IN ('queued', 'running', 'failed');

-- 进程间事件，供面板 SSE 推送
CREATE TABLE events (
    id         INTEGER PRIMARY KEY,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE TABLE users (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    totp_secret_enc BLOB,
    created_at      TEXT NOT NULL
);

CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,                   -- 会话令牌的哈希，不存明文令牌
    user_id          INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    totp_verified_at TEXT,
    ip               TEXT,
    user_agent       TEXT,
    created_at       TEXT NOT NULL,
    last_seen_at     TEXT NOT NULL,
    expires_at       TEXT NOT NULL
);

CREATE TABLE audit_log (
    id     INTEGER PRIMARY KEY,
    at     TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip     TEXT
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 全文索引：trigram 分词，支持 3 字及以上的中文子串检索
CREATE VIRTUAL TABLE search_fts USING fts5 (item_id UNINDEXED, body, tokenize = 'trigram');
