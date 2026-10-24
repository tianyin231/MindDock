import time

import pyotp
from conftest import PASSWORD, setup_account

from minddock.api.auth import init_auth_state, reset_accounts


def test_setup_requires_code_and_strong_password(client, app):
    assert client.get("/api/auth/state").json()["setup_required"] is True

    bad_code = client.post(
        "/api/auth/setup/start",
        json={"setup_code": "0000-0000", "username": "me", "password": PASSWORD},
    )
    assert bad_code.status_code == 403

    weak = client.post(
        "/api/auth/setup/start",
        json={"setup_code": app.state.auth.setup_code, "username": "me", "password": "short"},
    )
    assert weak.status_code == 422


def test_setup_rejects_wrong_totp_then_creates_account(client, app):
    started = client.post(
        "/api/auth/setup/start",
        json={"setup_code": app.state.auth.setup_code, "username": "me", "password": PASSWORD},
    ).json()
    assert started["totp_qr"].startswith("data:image/svg+xml")

    wrong = client.post(
        "/api/auth/setup/finish", json={"setup_token": started["setup_token"], "code": "000000"}
    )
    assert wrong.status_code == 400

    totp = pyotp.TOTP(started["totp_secret"])
    ok = client.post(
        "/api/auth/setup/finish", json={"setup_token": started["setup_token"], "code": totp.now()}
    )
    assert ok.status_code == 200
    assert {"md_session", "md_device"} <= set(client.cookies.keys())

    state = client.get("/api/auth/state").json()
    assert state == {"setup_required": False, "authenticated": True, "username": "me"}

    again = client.post(
        "/api/auth/setup/start",
        json={"setup_code": "anything", "username": "x", "password": PASSWORD},
    )
    assert again.status_code == 409


def test_new_device_needs_totp_and_trusted_device_skips_it(client, app):
    totp = setup_account(client, app)
    client.cookies.clear()  # 换一个"新浏览器"

    first = client.post("/api/auth/login", json={"username": "me", "password": PASSWORD}).json()
    assert first["status"] == "totp_required"

    wrong = client.post(
        "/api/auth/login/totp", json={"challenge": first["challenge"], "code": "000000"}
    )
    assert wrong.status_code == 401

    # 初始化时已用掉当前时间片的验证码，这里用下一个时间片
    code = totp.at(time.time() + 30)
    ok = client.post(
        "/api/auth/login/totp",
        json={"challenge": first["challenge"], "code": code, "trust_device": True},
    )
    assert ok.status_code == 200

    assert client.post("/api/auth/logout").status_code == 200
    assert client.get("/api/auth/state").json()["authenticated"] is False

    # 设备 Cookie 还在：只需密码
    again = client.post("/api/auth/login", json={"username": "me", "password": PASSWORD}).json()
    assert again == {"status": "ok"}
    assert client.get("/api/auth/state").json()["authenticated"] is True


def test_totp_code_cannot_be_reused(client, app):
    totp = setup_account(client, app)
    code = totp.at(time.time() + 30)
    for expected in (200, 401):
        client.cookies.clear()
        challenge = client.post(
            "/api/auth/login", json={"username": "me", "password": PASSWORD}
        ).json()["challenge"]
        resp = client.post("/api/auth/login/totp", json={"challenge": challenge, "code": code})
        assert resp.status_code == expected


def test_wrong_passwords_are_rate_limited(client, app):
    setup_account(client, app)
    client.cookies.clear()
    codes = [
        client.post(
            "/api/auth/login", json={"username": "me", "password": "wrong-password"}
        ).status_code
        for _ in range(6)
    ]
    assert codes == [401] * 5 + [429]


def test_unsafe_requests_need_csrf_header(client):
    resp = client.post(
        "/api/auth/login", json={"username": "me", "password": "x"}, headers={"X-MindDock": ""}
    )
    assert resp.status_code == 403


def test_settings_require_login(client):
    assert client.get("/api/settings").status_code == 401


def test_reset_accounts_reopens_setup_and_drops_sessions(client, app):
    setup_account(client, app)
    db = app.state.db
    assert reset_accounts(db) == 1
    assert db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM trusted_devices").fetchone()[0] == 0
    assert client.get("/api/auth/state").json()["authenticated"] is False
    assert init_auth_state(db).setup_code is not None
