-- 密钥库启用：一条消息可以存成多条密钥（文字与附件分开），记录来源、自动识别原因和附件类型；
-- 恢复码包裹私钥时的派生参数单独保存

CREATE TABLE secrets_new (
    id            TEXT PRIMARY KEY,
    short_code    TEXT NOT NULL UNIQUE,
    label         TEXT NOT NULL DEFAULT '',              -- 名称是明文，内容才加密
    kind          TEXT NOT NULL CHECK (kind IN ('text', 'file')),
    sealed        BLOB,                                  -- 文本密钥的密文（sealed box）
    blob_path     TEXT,                                  -- 文件密钥的密文路径，相对数据目录
    original_name TEXT,
    mime          TEXT,
    size          INTEGER,                               -- 明文大小
    source        TEXT NOT NULL DEFAULT 'qq' CHECK (source IN ('qq', 'panel')),
    detected      TEXT,                                  -- 自动识别的原因；显式 #key 为空
    source_msg_id TEXT,
    created_at    TEXT NOT NULL,
    trashed_at    TEXT
);
INSERT INTO secrets_new (id, short_code, label, kind, sealed, blob_path, original_name, size,
                         source_msg_id, created_at, trashed_at)
SELECT id, short_code, label, kind, sealed, blob_path, original_name, size, source_msg_id,
       created_at, trashed_at
FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;
CREATE INDEX secrets_msg ON secrets (source_msg_id);
CREATE INDEX secrets_list ON secrets (trashed_at, created_at DESC);

ALTER TABLE vault_keys ADD COLUMN rc_params TEXT NOT NULL DEFAULT '{}';
