from conftest import setup_account

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
