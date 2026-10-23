from fastapi.testclient import TestClient

from minddock.app import create_app
from minddock.config import Settings


def make_client(tmp_path, dist=None) -> TestClient:
    settings = Settings(data_dir=tmp_path / "data", web_dist_dir=dist or tmp_path / "no-dist")
    return TestClient(create_app(settings))


def test_health_reports_schema_version(tmp_path):
    with make_client(tmp_path) as client:
        body = client.get("/api/health").json()

    assert body["status"] == "ok"
    assert body["schema"] == 2


def test_spa_fallback_serves_index_but_not_for_api(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>MindDock</title>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")

    with make_client(tmp_path, dist) as client:
        assert "MindDock" in client.get("/todos").text
        assert client.get("/assets/app.js").text == "console.log(1)"
        assert client.get("/api/missing").status_code == 404
        # 路径穿越不能读到 dist 之外的文件
        assert "MindDock" in client.get("/..%2f..%2fpyproject.toml").text
