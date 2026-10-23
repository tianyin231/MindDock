"""命令行入口：python -m minddock <命令>。"""

import argparse
import logging

from minddock.config import get_settings
from minddock.db import connect, migrate


def main() -> None:
    parser = argparse.ArgumentParser(prog="minddock")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="应用数据库迁移")
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
    settings = get_settings()
    if args.command == "migrate":
        version = migrate(connect(settings.db_path))
        print(f"数据库已迁移到版本 {version}：{settings.db_path}")
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
