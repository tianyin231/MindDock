"""命令行入口：python -m minddock <命令>。"""

import argparse
import asyncio
import getpass
import logging
import os
import sys
from pathlib import Path

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


def _read_identity() -> str:
    """备份私钥：环境变量 MINDDOCK_BACKUP_IDENTITY，否则从标准输入读（install.sh 用管道传入），否则提示输入。"""
    if value := os.environ.get("MINDDOCK_BACKUP_IDENTITY"):
        return value
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return getpass.getpass("备份私钥（AGE-SECRET-KEY-…）：")


def _backup() -> int:
    from minddock import backup

    config = get_settings()
    conn = connect(config.db_path)
    try:
        result = backup.create_backup(conn, config)
    except backup.BackupError as exc:
        backup.record(conn, ok=False, error=str(exc), failedAt=_now())
        print(f"备份失败：{exc}", file=sys.stderr)
        return 1
    backup.record(conn, ok=True, error=None, last=result)
    counts = result["counts"]
    print(
        f"已备份：{config.data_dir / backup.BACKUP_DIR / result['name']}（{result['size']:,} 字节）\n"
        f"条目 {counts['items']}、密钥 {counts['secrets']}、文件记录 {counts['files']}，"
        f"随包文件 {result['files']} 个"
        + (f"，{result['missing']} 个本地文件已不存在" if result["missing"] else "")
    )
    return 0


def _restore(archive: Path, *, force: bool, check: bool) -> int:
    from minddock import backup

    if not archive.is_file():
        print(f"找不到备份文件：{archive}", file=sys.stderr)
        return 1
    identity = _read_identity()
    try:
        if check:
            result = backup.verify_backup(archive, identity)
        else:
            result = backup.restore_backup(archive, identity, get_settings().data_dir, force=force)
    except backup.BackupError as exc:
        print(f"恢复失败：{exc}", file=sys.stderr)
        return 1
    counts = result["counts"]
    print(
        f"{'校验通过' if check else '已恢复'}：备份时间 {result['createdAt']}，版本 {result['version']}，"
        f"数据库版本 {result['schema']}\n"
        f"条目 {counts['items']}、密钥 {counts['secrets']}、文件记录 {counts['files']}，"
        f"随包文件 {result['files']} 个；{result['remote']} 个原件将从夸克取回"
        + (f"；{result['lost']} 个未上传的原件备份时已不存在" if result["lost"] else "")
    )
    return 0


def _now() -> str:
    from minddock.db import now_iso

    return now_iso()


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
    sub.add_parser("backup", help="立即生成一份加密备份（保存在数据目录的 backups/ 下）")
    sub.add_parser("backup-keygen", help="生成备份密钥对（公钥写入 .env，私钥由你本人保存）")
    restore = sub.add_parser("restore", help="从加密备份恢复（私钥从标准输入或提示读取）")
    restore.add_argument("archive", type=Path, help="备份文件 minddock-*.tar.gz.age")
    restore.add_argument("--force", action="store_true", help="数据目录已有数据库时也覆盖")
    restore.add_argument(
        "--check", action="store_true", help="恢复演练：只解密并校验全部内容，不改动现有数据"
    )
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
    elif args.command == "backup":
        sys.exit(_backup())
    elif args.command == "backup-keygen":
        from minddock.backup import generate_keypair

        public, secret = generate_keypair()
        # 与 age-keygen 的输出格式相同，整段保存下来就是 age -d -i 能用的私钥文件
        print(
            f"# MindDock backup key, keep it in your password manager\n# public key: {public}\n{secret}"
        )
    elif args.command == "restore":
        sys.exit(_restore(args.archive, force=args.force, check=args.check))
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
