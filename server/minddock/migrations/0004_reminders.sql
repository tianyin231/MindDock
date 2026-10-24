-- 提醒送达：新增"已完成"状态、重复提醒的锚点时间、延后时间；被动回复改为按 QQ 消息记录次数

CREATE TABLE reminders_new (
    id         TEXT PRIMARY KEY,
    item_id    TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    remind_at  TEXT NOT NULL,                            -- 下一次提醒时间；重复提醒送达后前移
    anchor_at  TEXT NOT NULL,                            -- 重复提醒的起点，按它推算后续时间，避免月末日期漂移
    repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
    snooze_at  TEXT,                                     -- 重复提醒被延后时的额外提醒时间
    status     TEXT NOT NULL DEFAULT 'scheduled'
               CHECK (status IN ('scheduled', 'sent', 'done', 'failed', 'cancelled')),
    channel    TEXT,                                     -- 最近一次送达渠道：qq | email
    sent_at    TEXT,                                     -- 最近一次送达时间
    done_at    TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
);
INSERT INTO reminders_new (id, item_id, remind_at, anchor_at, repeat, status, channel, sent_at,
                           last_error, created_at)
SELECT id, item_id, remind_at, remind_at, repeat, status, channel, sent_at, last_error, created_at
FROM reminders;
DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;
CREATE INDEX reminders_due ON reminders (status, remind_at);
CREATE INDEX reminders_item ON reminders (item_id, created_at);

-- QQ 被动回复：收到消息后 60 分钟内可回复，同一消息最多 5 次，msg_seq 不能重复
CREATE TABLE qq_inbound (
    msg_id      TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    reply_seq   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX qq_inbound_received ON qq_inbound (received_at);
INSERT INTO qq_inbound (msg_id, received_at, reply_seq)
SELECT source_msg_id, created_at, reply_seq FROM items WHERE source_msg_id IS NOT NULL;
ALTER TABLE items DROP COLUMN reply_seq;
