from conftest import setup_account
from nacl.public import PrivateKey
from test_vault import fake_wrap

from minddock import vault
from minddock.ingest import Incoming, ingest


def add(app, text, msg_id):
    return ingest(app.state.db, Incoming(msg_id=msg_id, openid="me", content=text))


def test_items_api_lists_moves_and_searches(client, app):
    setup_account(client, app)
    first = add(app, "买猫粮和洗衣液", "m1")
    add(app, "周末徒步路线", "m2")

    inbox = client.get("/api/items", params={"partition": "inbox"}).json()
    assert len(inbox) == 2 and first.code in {i["code"] for i in inbox}
    assert client.get("/api/counts").json()["inbox"] == 2

    moved = client.post(f"/api/items/{first.item_id}/move", json={"partition": "todo"}).json()
    assert moved["partition"] == "todo" and moved["partitionSource"] == "user"
    done = client.post(f"/api/items/{first.item_id}/todo", json={"done": True}).json()
    assert done["todo"]["doneAt"]

    assert [i["id"] for i in client.get("/api/search", params={"q": "猫粮"}).json()] == [
        first.item_id
    ]
    assert [i["id"] for i in client.get("/api/search", params={"q": "洗衣液"}).json()] == [
        first.item_id
    ]
    assert client.get("/api/items/nope").status_code == 404
    assert (
        client.post(f"/api/items/{first.item_id}/move", json={"partition": "secret"}).status_code
        == 422
    )


def test_add_todo_from_panel(client, app):
    setup_account(client, app)
    created = client.post("/api/todos", json={"title": "预约体检"}).json()
    assert created["partition"] == "todo" and created["source"] == "panel"


def test_qq_binding_code_and_status(client, app):
    setup_account(client, app)
    state = client.get("/api/qq").json()
    assert state["status"]["state"] == "stopped" and not state["owner"]["bound"]

    created = client.post("/api/qq/bind").json()
    assert len(created["bind"]["code"]) == 6
    assert client.delete("/api/qq/owner").json()["owner"]["bound"] is False


def test_item_endpoints_require_login(client):
    assert client.get("/api/items", params={"partition": "inbox"}).status_code == 401
    assert client.get("/api/events").status_code == 401


def test_reminder_actions_from_panel(client, app):
    setup_account(client, app)
    item = add(app, "周五交房租", "r1")
    client.post(f"/api/items/{item.item_id}/move", json={"partition": "reminder"})
    url = f"/api/items/{item.item_id}/reminder"

    past = client.post(url, json={"action": "reschedule", "remind_at": "2020-01-01T08:00:00+08:00"})
    assert past.status_code == 422
    set_ = client.post(
        url,
        json={"action": "reschedule", "remind_at": "2099-01-01T09:30:00.000Z", "repeat": "monthly"},
    ).json()
    assert set_["reminder"]["remindAt"] == "2099-01-01T09:30:00Z"
    assert set_["reminder"]["repeat"] == "monthly" and set_["reminder"]["status"] == "scheduled"

    snoozed = client.post(url, json={"action": "snooze", "minutes": 10}).json()
    assert snoozed["reminder"]["remindAt"] < "2099-01-01T09:30:00Z"
    assert client.post(url, json={"action": "cancel"}).json()["reminder"]["status"] == "cancelled"
    assert client.post(url, json={"action": "done"}).status_code == 422

    assert client.post("/api/qq/test").json()["ok"] is False  # 未配置机器人


def test_timeline_merges_partitions_and_secrets_with_paging(client, app):
    setup_account(client, app)
    db = app.state.db
    vault.setup(db, bytes(PrivateKey.generate().public_key), fake_wrap(), fake_wrap())
    # 同一秒内写入多条，验证按 id 排序后翻页不漏不重
    ids = [add(app, f"第 {n} 条", f"t{n}").item_id for n in range(5)]
    client.post(f"/api/items/{ids[0]}/move", json={"partition": "note"})
    secret = vault.store_text(db, vault.public_key(db), "路由器", "abc")

    first = client.get("/api/timeline", params={"limit": 4}).json()
    assert len(first["entries"]) == 4 and first["next"]
    second = client.get("/api/timeline", params={"limit": 4, "before": first["next"]}).json()
    assert second["next"] is None
    entries = first["entries"] + second["entries"]
    seen = [e["item"]["id"] if e["kind"] == "item" else e["secret"]["id"] for e in entries]
    assert sorted(seen) == sorted([*ids, secret["id"]])
    assert all("sealed" not in e["secret"] for e in entries if e["kind"] == "secret")
    assert {e["item"]["partition"] for e in entries if e["kind"] == "item"} == {"inbox", "note"}


def test_add_text_from_panel_goes_through_pipeline(client, app):
    setup_account(client, app)
    created = client.post("/api/items", json={"text": "  读完《原则》第三章  "}).json()
    assert created["kind"] == "item"
    assert created["item"]["source"] == "panel" and created["item"]["partition"] == "inbox"
    assert created["item"]["text"] == "读完《原则》第三章"
    assert client.post("/api/items", json={"text": "   "}).status_code == 422

    # 密钥：库未启用时不保存；启用后加密入库，不产生普通条目
    assert client.post("/api/items", json={"text": "#key 路由器\nabc123"}).status_code == 409
    vault.setup(app.state.db, bytes(PrivateKey.generate().public_key), fake_wrap(), fake_wrap())
    stored = client.post("/api/items", json={"text": "#key 路由器\nabc123"}).json()
    assert stored["kind"] == "secret" and stored["secret"]["label"] == "路由器"
    assert stored["secret"]["source"] == "panel"
    assert client.post("/api/items", json={"text": "#key"}).status_code == 422
    assert client.get("/api/counts").json()["inbox"] == 1
