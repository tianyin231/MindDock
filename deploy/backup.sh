#!/usr/bin/env bash
# 立即做一份加密备份（迁移前在旧服务器上运行），并打印备份文件的位置。
#   bash /opt/minddock/deploy/backup.sh            生成备份
#   bash /opt/minddock/deploy/backup.sh --key-only 只确保已有备份密钥（install.sh 调用）
#
# 第一次运行时会生成备份密钥：公钥写进 .env，私钥写到 /root/minddock-backup-key.txt，
# 请把私钥存进密码管理器后删除这个文件。没有私钥无法解密备份。
set -euo pipefail
cd /opt/minddock

KEY_FILE=/root/minddock-backup-key.txt

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

ensure_key() {
  if grep -q '^MINDDOCK_BACKUP_RECIPIENT=age1' .env; then
    return 1
  fi
  say "生成备份密钥"
  # 旧的私钥文件还在（可能还没保存走）时绝不覆盖
  if [ -e "$KEY_FILE" ]; then
    KEY_FILE="${KEY_FILE%.txt}-$(date +%Y%m%d%H%M%S).txt"
  fi
  local tag
  tag=$(grep '^MINDDOCK_TAG=' .env | cut -d= -f2- || true)
  (umask 077 && docker run --rm "ghcr.io/tianyin231/minddock:${tag:-main}" python -m minddock backup-keygen > "$KEY_FILE")
  local public
  public=$(awk '/^# public key:/ {print $4}' "$KEY_FILE")
  [ -n "$public" ] || { echo "生成备份密钥失败" >&2; exit 1; }
  { grep -v '^MINDDOCK_BACKUP_RECIPIENT=' .env || true; echo "MINDDOCK_BACKUP_RECIPIENT=$public"; } > .env.tmp
  chmod 600 .env.tmp && mv .env.tmp .env
  printf '\033[1;33m备份私钥已写入 %s：请把整个文件内容存进密码管理器（KeePassXC 等），然后删除它：rm %s\n没有这把私钥，备份无法解密；迁移到新服务器时也需要它。\033[0m\n' "$KEY_FILE" "$KEY_FILE"
  return 0
}

if [ "${1:-}" = --key-only ]; then
  ensure_key || true
  exit 0
fi

if ensure_key; then
  # 新公钥要重建容器才能读到
  docker compose up -d >/dev/null
  sleep 3
fi

docker compose exec -T panel python -m minddock backup
latest=$(ls -1t data/panel/backups/minddock-*.tar.gz.age 2>/dev/null | head -1)
[ -n "$latest" ] || exit 1
echo
echo "备份文件：/opt/minddock/$latest"
echo "迁移到新服务器：把它复制过去（例如 scp），在新服务器上运行"
echo "  curl -fsSL https://raw.githubusercontent.com/tianyin231/MindDock/main/deploy/install.sh | bash -s -- <域名> --restore <备份文件>"
echo "新服务器启动后，记得停掉这台的 MindDock：cd /opt/minddock && docker compose down"
