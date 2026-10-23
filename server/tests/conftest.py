import base64
import os

import pyotp
import pytest
from fastapi.testclient import TestClient

from minddock.app import create_app
from minddock.config import Settings

PASSWORD = "correct horse battery"


@pytest.fixture
def app(tmp_path):
    config = Settings(
        data_dir=tmp_path / "data",
        web_dist_dir=tmp_path / "no-dist",
        cookie_secure=False,
        secret_key=base64.b64encode(os.urandom(32)).decode(),
    )
    return create_app(config)


@pytest.fixture
def client(app):
    with TestClient(app, headers={"X-MindDock": "1"}) as c:
        yield c


def setup_account(client, app, username="me", password=PASSWORD) -> pyotp.TOTP:
    """完成首次初始化，返回该账号的 TOTP 生成器。"""
    started = client.post(
        "/api/auth/setup/start",
        json={"setup_code": app.state.auth.setup_code, "username": username, "password": password},
    ).json()
    totp = pyotp.TOTP(started["totp_secret"])
    resp = client.post(
        "/api/auth/setup/finish", json={"setup_token": started["setup_token"], "code": totp.now()}
    )
    assert resp.status_code == 200, resp.text
    return totp
