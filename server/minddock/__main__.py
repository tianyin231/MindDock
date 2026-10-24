"""命令行入口：python -m minddock <命令>。"""

import argparse
import asyncio
import logging

from minddock.config import get_settings
from minddock.db import connect, migrate


async def _check(sections: list[str]) -> None:
    """用已保存的设置运行"测试连接"，只输出结果，不输出任何密钥。"""
    import httpx2

    from minddock.integrations.openlist import OpenListClient
    from minddock.integrations.probes import probe_ai, probe_qq, probe_storage
    from minddock.security import load_cipher
    from minddock.settings_store import SettingsStore

    config = get_settings()
    conn = connect(config.db_path)
    store = SettingsStore(conn, load_cipher(config.secret_key, config.data_dir))
    async with httpx2.AsyncClient(timeout=30, follow_redirects=True) as http:
        for key in sections:
            if not store.configured(key):
                print(f"[{key}] 未配置")
                continue
            cfg = store.get(key)
            try:
                if key == "qq":
                    result = await probe_qq(cfg, http)
                elif key == "ai":
                    result = await probe_ai(cfg, http)
                else:
                    client = OpenListClient(
                        config.openlist_url, config.openlist_admin_password, http
                    )
                    result = await probe_storage(cfg, client)
            except Exception as exc:
                print(f"[{key}] 出错：{type(exc).__name__}: {exc}")
                continue
            print(f"[{key}] {'通过' if result.ok else '失败'}：{result.message} {result.details}")


async def _run_service(name: str) -> None:
    """常驻服务：bot（QQ 连接）或 worker（后台任务）。"""
    import httpx2

    from minddock.db import wait_for_schema
    from minddock.security import load_cipher
    from minddock.settings_store import SettingsStore

    config = get_settings()
    conn = connect(config.db_path)
    await wait_for_schema(conn)
    store = SettingsStore(conn, load_cipher(config.secret_key, config.data_dir))
    async with httpx2.AsyncClient(timeout=30, follow_redirects=True) as http:
        if name == "bot":
            from minddock.bot import Bot

            await Bot(conn, store, http, config).run()
        else:
            from minddock.worker import Worker

            await Worker(conn, store, http, config).run()


def main() -> None:
    parser = argparse.ArgumentParser(prog="minddock")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="应用数据库迁移")
    sub.add_parser(
        "reset-account",
        help="忘记密码或丢失验证器时：删除登录账号（内容和设置保留），重启面板后重新初始化",
    )
    check = sub.add_parser("check", help="用已保存的设置测试各项连接")
    check.add_argument("sections", nargs="*", default=["qq", "ai", "storage"])
    sub.add_parser("bot", help="启动常驻 QQ 连接")
    sub.add_parser("worker", help="启动后台任务（下载附件、AI 整理）")
    panel = sub.add_parser("panel", help="启动面板服务")
    panel.add_argument("--host", help="监听地址，默认取配置 panel_host")
    panel.add_argument("--port", type=int, help="监听端口，默认取配置 panel_port")
    panel.add_argument("--reload", action="store_true", help="开发模式：代码变化时自动重启")
    panel.add_argument(
        "--proxy-headers", action="store_true", help="部署在反向代理之后：信任其转发的客户端 IP"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    # HTTP 客户端默认逐条记录请求地址；附件下载地址可能带访问令牌，不写进日志
    for noisy in ("httpx2", "httpcore2", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    settings = get_settings()
    if args.command == "migrate":
        version = migrate(connect(settings.db_path))
        print(f"数据库已迁移到版本 {version}：{settings.db_path}")
    elif args.command == "reset-account":
        from minddock.api.auth import reset_accounts

        removed = reset_accounts(connect(settings.db_path))
        print(f"已删除 {removed} 个登录账号。重启面板后，日志里会打印新的初始化码。")
    elif args.command == "check":
        asyncio.run(_check(args.sections))
    elif args.command in ("bot", "worker"):
        asyncio.run(_run_service(args.command))
    elif args.command == "panel":
        import uvicorn

        uvicorn.run(
            "minddock.app:create_app",
            factory=True,
            host=args.host or settings.panel_host,
            port=args.port or settings.panel_port,
            reload=args.reload,
            proxy_headers=args.proxy_headers,
            # 面板端口只在容器内网暴露给 Caddy，因此信任其转发头
            forwarded_allow_ips="*" if args.proxy_headers else None,
            log_level="info",
        )


if __name__ == "__main__":
    main()
