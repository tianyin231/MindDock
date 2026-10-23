"""收件闭环：密钥识别、任务队列、入库、AI 整理、机器人绑定与命令、网关协议。"""

import asyncio
import json
from datetime import timedelta

import httpx2
import pytest

from minddock.bot import BIND_KEY, OWNER_KEY, Bot, parse_c2c
from minddock.config import Settings
from minddock.db import connect, migrate, now_iso
from minddock.ingest import Incoming, IncomingAttachment, ingest
from minddock.items import item_to_api, move, search
from minddock.jobs import MAX_ATTEMPTS, claim, complete, enqueue, fail
from minddock.organize import organize_item, parse_json_reply
from minddock.qq.gateway import FatalGatewayError, Gateway
from minddock.secret_rules import detect_secret
from minddock.security import Cipher
from minddock.settings_store import SettingsStore
from minddock.timeutil import local_now
from minddock.util import kv_get, kv_set

TZ = "Asia/Shanghai"
AI_CFG = {"base_url": "https://ai.example.com/v1", "api_key": "k", "model_text": "m"}


@pytest.fixture
def conn(tmp_path):
    c = connect(tmp_path / "t.db")
    migrate(c)
    return c


def msg(text="", msg_id="m1", openid="owner", attachments=None) -> Incoming:
    return Incoming(msg_id=msg_id, openid=openid, content=text, attachments=attachments or [])


# ---- 密钥识别 ----


@pytest.mark.parametrize(
    "text",
    [
        "#key 测试库密码\nabc",
        "sk-proj-abcdefghijklmnopqrstuvwx",
        "数据库 密码：Abc12345678",
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "token=Zq8#kL2$vN9@xP4!mR7&tY1^wB5*cD3a",
    ],
)
def test_secrets_are_detected(text):
    assert detect_secret(text)


@pytest.mark.parametrize(
    "text",
    [
        "明天下午三点提醒我交周报",
        "https://github.com/tianyin231/MindDock/blob/main/docs/design.md?plain=1#L100",
        "今天学习了Python3.12的新特性和asyncio的TaskGroup用法真不错呀呀呀呀",
    ],
)
def test_normal_messages_are_not_secrets(text):
    assert detect_secret(text) is None


# ---- 任务队列 ----


def test_job_is_unique_while_active_and_backs_off(conn):
    enqueue(conn, "organize", "i1")
    enqueue(conn, "organize", "i1")
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 1

    job = claim(conn)
    assert job.attempts == 1 and claim(conn) is None
    assert fail(conn, job, "boom") == "failed"
    assert claim(conn) is None  # 还没到重试时间

    conn.execute("UPDATE jobs SET attempts = ?, run_after = ?", (MAX_ATTEMPTS - 1, now_iso()))
    job = claim(conn)
    assert fail(conn, job, "boom") == "dead"


def test_completed_job_allows_new_one(conn):
    enqueue(conn, "download", "f1")
    complete(conn, claim(conn))
    enqueue(conn, "download", "f1")
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 2


# ---- 入库 ----


def test_ingest_creates_item_files_jobs_and_event_once(conn):
    att = IncomingAttachment(
        url="https://q.example/img", filename="a.jpg", content_type="image/jpeg"
    )
    result = ingest(conn, msg("周末的照片 #徒步", attachments=[att]))
    assert result.summary == "文字、图片" and result.organizing

    item = item_to_api(conn, result.item_id)
    assert item["partition"] == "inbox"
    assert item["processing"] == {"stage": "organizing"}
    assert item["tags"] == ["徒步"]
    assert item["attachments"][0]["kind"] == "image"

    jobs = {r[0] for r in conn.execute("SELECT type FROM jobs")}
    assert jobs == {"download", "organize"}
    assert conn.execute("SELECT type FROM events").fetchone()[0] == "item.received"
    assert ingest(conn, msg("周末的照片")) is None  # 同一 msg_id 重复投递


def test_noai_skips_organize(conn):
    result = ingest(conn, msg("随手记 #noai"))
    assert not result.organizing
    assert conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0
    assert "手动归类" in item_to_api(conn, result.item_id)["processing"]["error"]


# ---- AI 整理 ----


def ai_reply(payload: dict):
    def handler(req: httpx2.Request) -> httpx2.Response:
        if req.url.host == "ai.example.com":
            content = "<think>想一想</think>" + json.dumps(payload, ensure_ascii=False)
            return httpx2.Response(200, json={"choices": [{"message": {"content": content}}]})
        html = "<html><head><title>好文章</title></head><body><article><p>正文内容。</p></article></body></html>"
        return httpx2.Response(200, html=html)

    return handler


def organize(conn, item_id, payload):
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(ai_reply(payload))) as http:
            return await organize_item(conn, http, AI_CFG, item_id, TZ)

    return asyncio.run(go())


def test_reminder_time_is_stored_in_utc_and_confirmed(conn):
    result = ingest(conn, msg("明天下午三点提醒我交周报"))
    tomorrow = (local_now(TZ) + timedelta(days=1)).strftime("%Y-%m-%d")
    outcome = organize(
        conn,
        result.item_id,
        {
            "partition": "reminder",
            "title": "交周报",
            "summary": "",
            "tags": ["工作"],
            "due_at": None,
            "remind_at": f"{tomorrow}T15:00:00+08:00",
            "repeat": "none",
        },
    )
    assert outcome.item["partition"] == "reminder"
    assert outcome.item["reminder"]["remindAt"] == f"{tomorrow}T07:00:00Z"
    assert outcome.follow_up == f"⏰ #{result.code} 已设提醒：明天 15:00"
    assert search(conn, "交周报")[0]["id"] == result.item_id


def test_reminder_without_valid_time_becomes_todo(conn):
    result = ingest(conn, msg("提醒我买牛奶"))
    outcome = organize(
        conn,
        result.item_id,
        {
            "partition": "reminder",
            "title": "买牛奶",
            "summary": "",
            "tags": [],
            "due_at": None,
            "remind_at": "2020-01-01T08:00:00+08:00",
            "repeat": "none",
        },
    )
    assert outcome.item["partition"] == "todo"
    assert "待办" in outcome.follow_up


def test_link_is_fetched_and_manual_partition_is_kept(conn):
    result = ingest(conn, msg("https://blog.example.com/post 这篇不错"))
    move(conn, result.item_id, "note")  # AI 完成前用户已手动归类
    outcome = organize(
        conn,
        result.item_id,
        {
            "partition": "bookmark",
            "title": "好文章",
            "summary": "一篇文章",
            "tags": ["阅读"],
            "due_at": None,
            "remind_at": None,
            "repeat": "none",
        },
    )
    assert outcome.item["partition"] == "note"
    assert outcome.item["link"]["title"] == "好文章"
    assert outcome.item["link"]["site"] == "blog.example.com"


def test_json_reply_tolerates_wrapping():
    assert parse_json_reply('```json\n{"a": 1}\n```') == {"a": 1}


# ---- 机器人 ----


class FakeQQ:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []

    async def send_c2c(self, openid, content, msg_id=None, msg_seq=1):
        self.sent.append((openid, content))
        return {}


@pytest.fixture
def bot(conn, tmp_path):
    store = SettingsStore(conn, Cipher(b"k" * 32))
    b = Bot(conn, store, None, Settings(data_dir=tmp_path))
    b.api = FakeQQ()
    return b


def test_binding_then_only_owner_is_served(bot, conn):
    asyncio.run(bot.on_c2c(msg("你好", msg_id="a", openid="stranger")))
    assert "还没有绑定" in bot.api.sent[-1][1]

    kv_set(conn, BIND_KEY, {"code": "123456", "expires_at": now_iso(600), "attempts": 0})
    asyncio.run(bot.on_c2c(msg("绑定 123456", msg_id="b", openid="me")))
    assert kv_get(conn, OWNER_KEY)["openid"] == "me"
    assert "绑定成功" in bot.api.sent[-1][1]

    asyncio.run(bot.on_c2c(msg("我也想用", msg_id="c", openid="stranger")))
    assert bot.api.sent[-1][0] == "me"  # 陌生人没有收到任何回复

    asyncio.run(bot.on_c2c(msg("买猫粮", msg_id="d", openid="me")))
    assert bot.api.sent[-1][1].startswith("✅ #")

    asyncio.run(bot.on_c2c(msg("#key 路由器密码\nabc", msg_id="e", openid="me")))
    assert "没有保存" in bot.api.sent[-1][1]
    assert conn.execute("SELECT COUNT(*) FROM items").fetchone()[0] == 1

    asyncio.run(bot.on_c2c(msg("/s 猫粮", msg_id="f", openid="me")))
    assert "处理中 · 买猫粮" in bot.api.sent[-1][1]


def test_wrong_bind_codes_expire_the_code(bot, conn):
    kv_set(conn, BIND_KEY, {"code": "123456", "expires_at": now_iso(600), "attempts": 0})
    for i in range(5):
        asyncio.run(bot.on_c2c(msg("000000", msg_id=f"x{i}", openid="attacker")))
    assert kv_get(conn, BIND_KEY) is None
    assert kv_get(conn, OWNER_KEY) is None


def test_parse_c2c_event():
    data = {
        "id": "ROBOT1.0_abc",
        "author": {"user_openid": "OPENID"},
        "content": " 你好 ",
        "attachments": [
            {"url": "//multimedia.nt.qq.com.cn/x", "filename": "a.png", "content_type": "image/png"}
        ],
    }
    parsed = parse_c2c(data)
    assert parsed.openid == "OPENID" and parsed.msg_id == "ROBOT1.0_abc"
    assert parsed.attachments[0].url.startswith("https://")


# ---- 网关协议 ----


def test_gateway_tracks_session_and_dispatches():
    async def go():
        statuses, events = [], []

        async def on_dispatch(event, data):
            events.append(event)

        gw = Gateway(api=None, on_dispatch=on_dispatch, on_status=lambda s, d: statuses.append(s))
        assert gw.handle({"op": 0, "s": 1, "t": "READY", "d": {"session_id": "S"}})
        assert gw.handle({"op": 0, "s": 2, "t": "C2C_MESSAGE_CREATE", "d": {}})
        await asyncio.sleep(0)
        assert gw.session_id == "S" and gw.seq == 2
        assert statuses == ["online"] and events == ["C2C_MESSAGE_CREATE"]
        assert gw.resume_payload("T")["d"] == {"token": "QQBot T", "session_id": "S", "seq": 2}
        assert gw.handle({"op": 7}) is False and gw.session_id == "S"
        assert gw.handle({"op": 9, "d": False}) is False and gw.session_id is None

    asyncio.run(go())


def test_gateway_fatal_close_codes():
    gw = Gateway(api=None, on_dispatch=None, on_status=lambda s, d: None)
    with pytest.raises(FatalGatewayError):
        gw.handle_close(4014)
    gw.session_id, gw.seq = "S", 5
    gw.handle_close(4009)
    assert gw.session_id is None
