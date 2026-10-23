-- 收件闭环：附件的原始下载地址、对同一条 QQ 消息已回复的次数
ALTER TABLE files ADD COLUMN source_url TEXT;                        -- QQ 附件地址，有时效
ALTER TABLE items ADD COLUMN reply_seq INTEGER NOT NULL DEFAULT 0;   -- 被动回复的 msg_seq，同一消息内递增
CREATE INDEX events_created ON events (created_at);
