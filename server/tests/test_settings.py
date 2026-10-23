import asyncio
import json

import httpx2
from conftest import setup_account

from minddock.integrations.openlist import OpenListClient
from minddock.integrations.probes import probe_ai, probe_qq, probe_storage

SECRET = "app-secret-value-9876"


def qq_values(client) -> dict:
    sections = client.get("/api/settings").json()["sections"]
    return next(s for s in sections if s["key"] == "qq")


def test_secret_is_masked_encrypted_and_kept_on_partial_update(client, app):
    setup_account(client, app)

    saved = client.put(
        "/api/settings/qq", json={"values": {"app_id": "1020", "app_secret": SECRET}}
    ).json()
    assert saved["values"]["app_secret"] == {"set": True, "hint": "9876"}
    assert saved["configured"] is True

    raw = app.state.db.execute("SELECT value FROM settings WHERE key = 'section:qq'").fetchone()[0]
    assert SECRET not in raw  # 数据库里只有密文

    client.put("/api/settings/qq", json={"values": {"app_id": "1021"}})
    section = qq_values(client)
    assert section["values"]["app_id"] == "1021"
    assert section["values"]["app_secret"]["set"] is True

    client.put("/api/settings/qq", json={"values": {"app_secret": None}})
    assert qq_values(client)["configured"] is False


def test_unknown_or_invalid_fields_are_rejected(client, app):
    setup_account(client, app)
    assert client.put("/api/settings/qq", json={"values": {"nope": 1}}).status_code == 422
    assert (
        client.put("/api/settings/notify", json={"values": {"smtp_port": "abc"}}).status_code == 422
    )
    assert client.put("/api/settings/unknown", json={"values": {}}).status_code == 422


def test_test_endpoint_requires_configuration(client, app):
    setup_account(client, app)
    result = client.post("/api/settings/ai/test").json()
    assert result["ok"] is False


def run(probe_coro_factory, handler):
    async def go():
        async with httpx2.AsyncClient(transport=httpx2.MockTransport(handler)) as http:
            return await probe_coro_factory(http)

    return asyncio.run(go())


def test_probe_qq_success_and_bad_secret():
    def ok(req: httpx2.Request):
        if req.url.path == "/app/getAppAccessToken":
            assert json.loads(req.content)["clientSecret"] == "s"
            return httpx2.Response(200, json={"access_token": "tok", "expires_in": "7200"})
        assert req.headers["Authorization"] == "QQBot tok"
        assert req.url.host == "sandbox.api.sgroup.qq.com"
        return httpx2.Response(200, json={"url": "wss://sandbox.api.sgroup.qq.com/websocket"})

    cfg = {"app_id": "1", "app_secret": "s", "sandbox": True}
    result = run(lambda http: probe_qq(cfg, http), ok)
    assert result.ok and result.details["gateway"].startswith("wss://")

    bad = run(
        lambda http: probe_qq(cfg, http),
        lambda req: httpx2.Response(
            200, json={"code": 100016, "message": "invalid appid or secret"}
        ),
    )
    assert not bad.ok and "invalid appid" in bad.message


def test_probe_ai_falls_back_to_json_mode():
    def handler(req: httpx2.Request):
        body = json.loads(req.content)
        if body.get("response_format", {}).get("type") == "json_schema":
            return httpx2.Response(400, json={"error": {"message": "json_schema not supported"}})
        return httpx2.Response(200, json={"choices": [{"message": {"content": "OK"}}]})

    cfg = {"base_url": "https://ai.example.com/v1/", "api_key": "k", "model_text": "m"}
    result = run(lambda http: probe_ai(cfg, http), handler)
    assert result.ok
    assert result.details["structured_output"] == "json_object"


class FakeOpenList:
    """最小化模拟 OpenList 接口：存储列表、文件增删查。"""

    def __init__(self):
        self.storages: list[dict] = []
        self.files: dict[str, dict[str, int]] = {"/quark": {}}

    def __call__(self, req: httpx2.Request) -> httpx2.Response:
        path = req.url.path
        body = json.loads(req.content) if req.content and path != "/api/fs/put" else {}
        if path == "/api/auth/login":
            return self.ok({"token": "jwt"})
        assert req.headers["Authorization"] == "jwt"
        if path == "/api/admin/storage/list":
            return self.ok({"content": self.storages, "total": len(self.storages)})
        if path == "/api/admin/storage/create":
            assert json.loads(body["addition"])["cookie"] == "cookie-value"
            self.storages.append({**body, "id": 1, "status": "work"})
            return self.ok({"id": 1})
        if path == "/api/fs/list":
            entries = self.files.get(body["path"], {})
            return self.ok({"content": [{"name": n, "size": s} for n, s in entries.items()]})
        if path == "/api/fs/mkdir":
            parent, name = body["path"].rsplit("/", 1)
            self.files[parent][name] = 0
            self.files[body["path"]] = {}
            return self.ok(None)
        if path == "/api/fs/put":
            from urllib.parse import unquote

            parent, name = unquote(req.headers["File-Path"]).rsplit("/", 1)
            self.files[parent][name] = len(req.content)
            return self.ok(None)
        if path == "/api/fs/remove":
            for name in body["names"]:
                self.files[body["dir"]].pop(name)
            return self.ok(None)
        raise AssertionError(f"未模拟的接口 {path}")

    @staticmethod
    def ok(data):
        return httpx2.Response(200, json={"code": 200, "message": "success", "data": data})


def test_probe_storage_mounts_quark_and_round_trips_a_file():
    fake = FakeOpenList()
    cfg = {"quark_cookie": "cookie-value", "folder": "MindDock"}
    result = run(
        lambda http: probe_storage(cfg, OpenListClient("http://openlist:5244", "pw", http)), fake
    )
    assert result.ok, result.message
    assert fake.storages[0]["driver"] == "Quark"
    assert fake.files["/quark/MindDock"] == {}  # 测试文件已删除
