"""命令行入口：python -m minddock <命令>。"""

import argparse

from minddock.config import get_settings
from minddock.db import connect, migrate


def main() -> None:
    parser = argparse.ArgumentParser(prog="minddock")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("migrate", help="应用数据库迁移")
    panel = sub.add_parser("panel", help="启动面板服务")
    panel.add_argument("--reload", action="store_true", help="开发模式：代码变化时自动重启")
    args = parser.parse_args()

    settings = get_settings()
    if args.command == "migrate":
        version = migrate(connect(settings.db_path))
        print(f"数据库已迁移到版本 {version}：{settings.db_path}")
    elif args.command == "panel":
        import uvicorn

        uvicorn.run(
            "minddock.app:create_app",
            factory=True,
            host=settings.panel_host,
            port=settings.panel_port,
            reload=args.reload,
        )


if __name__ == "__main__":
    main()
