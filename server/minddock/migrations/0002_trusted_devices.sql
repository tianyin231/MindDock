-- 受信任设备：在这个浏览器上通过验证码后 30 天内只需密码
CREATE TABLE trusted_devices (
    id           TEXT PRIMARY KEY,                       -- 设备令牌的哈希
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_agent   TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
);
CREATE INDEX trusted_devices_user ON trusted_devices (user_id);
