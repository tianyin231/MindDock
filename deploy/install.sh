#!/usr/bin/env bash
# 首次部署（以 root 运行，可重复执行）：
#   curl -fsSL https://raw.githubusercontent.com/tianyin231/MindDock/main/deploy/install.sh | bash -s -- minddock.example.com
# 或在已克隆的仓库里：bash deploy/install.sh minddock.example.com
#
# 选项：
#   --mode auto|bt|direct  入口模式。auto（默认）：有宝塔 nginx 用宝塔模式，否则 80/443 空闲时用独立模式
#   --restore <备份文件>    迁移：从 backup.sh 生成的加密备份恢复全部数据与配置
#   --key <私钥文件>        备份私钥（不指定时会提示粘贴）
set -euo pipefail

DIR=/opt/minddock
REPO=https://github.com/tianyin231/MindDock.git

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }

DOMAIN=""
MODE=auto
RESTORE=""
KEY_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="${2:?--mode 需要 auto、bt 或 direct}"; shift 2 ;;
    --restore) RESTORE="$(readlink -f "${2:?--restore 需要备份文件路径}")"; shift 2 ;;
    --key) KEY_FILE="${2:?--key 需要私钥文件路径}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    -*) die "未知选项：$1" ;;
    *) DOMAIN="$1"; shift ;;
  esac
done
[ -n "$DOMAIN" ] || die "用法：install.sh <域名> [--mode auto|bt|direct] [--restore <备份文件> [--key <私钥文件>]]"
[ "$(id -u)" -eq 0 ] || die "请以 root 运行"
case "$MODE" in auto|bt|direct) ;; *) die "--mode 只能是 auto、bt 或 direct" ;; esac
if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] || die "找不到备份文件：$RESTORE"
  [ ! -f "$DIR/data/panel/minddock.db" ] || die "$DIR/data/panel 里已经有数据。恢复会覆盖它们：确认的话先把这个目录移走再运行"
  # 先拿到私钥，免得装了一半才发现没有
  if [ -n "$KEY_FILE" ]; then
    IDENTITY=$(cat "$KEY_FILE")
  elif [ -n "${MINDDOCK_BACKUP_IDENTITY:-}" ]; then
    IDENTITY=$MINDDOCK_BACKUP_IDENTITY
  else
    printf '请粘贴备份私钥（AGE-SECRET-KEY-… 那一行，输入不会显示），回车结束：' > /dev/tty
    read -rs IDENTITY < /dev/tty
    echo > /dev/tty
  fi
  grep -q 'AGE-SECRET-KEY-' <<<"$IDENTITY" || die "没有读到备份私钥（以 AGE-SECRET-KEY- 开头）"
fi

BT_NGINX=/www/server/panel/vhost/nginx
port_holder() { ss -Hltnp "sport = :$1" 2>/dev/null | grep -v docker-proxy || true; }

# ---- 基础工具与 Docker ----

missing=()
for cmd in git curl openssl ss; do
  command -v "$cmd" >/dev/null || missing+=("$cmd")
done
if [ ${#missing[@]} -gt 0 ]; then
  say "安装基础工具：${missing[*]}"
  if command -v apt-get >/dev/null; then
    apt-get update -qq
    apt-get install -y -qq git curl openssl iproute2 >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q git curl openssl iproute
  elif command -v yum >/dev/null; then
    yum install -y -q git curl openssl iproute
  else
    die "缺少 ${missing[*]}，请先手动安装"
  fi
fi

if ! command -v docker >/dev/null; then
  say "安装 Docker（官方脚本 get.docker.com）"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
fi
docker compose version >/dev/null 2>&1 || die "缺少 docker compose 插件，请安装 docker-compose-plugin"

# ---- 代码 ----

say "代码：$DIR"
if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git pull --ff-only

# ---- 入口模式 ----

current_mode=$(grep -s '^MINDDOCK_MODE=' .env | cut -d= -f2- || true)
if [ "$MODE" = auto ]; then
  if [ -n "$current_mode" ]; then
    MODE=$current_mode
  elif [ -d "$BT_NGINX" ]; then
    MODE=bt
  elif [ -z "$(port_holder 80)$(port_holder 443)" ]; then
    MODE=direct
  else
    die "80 或 443 端口已被占用，且没有找到宝塔 nginx：
$(port_holder 80)$(port_holder 443)
可以停掉占用端口的程序后用 --mode direct，或让现有的反向代理按 deploy/nginx-sni-443.conf 转发后用 --mode bt"
  fi
fi
say "入口模式：$([ "$MODE" = bt ] && echo '宝塔模式（宝塔 nginx 转发给 Caddy）' || echo '独立模式（Caddy 直接监听 80/443）')"

# ---- .env ----

# 写入或替换 .env 中的一项
set_env() {
  local key=$1 value=$2
  { grep -v "^$key=" .env || true; echo "$key=$value"; } > .env.tmp
  mv .env.tmp .env
}

if [ ! -f .env ]; then
  say "生成 .env（加密主密钥与 OpenList 管理员密码，仅保存在本机）"
  umask 077
  cat > .env <<EOF
# MindDock 部署配置。业务设置（QQ、AI、网盘、邮件）请在面板中填写。
MINDDOCK_DOMAIN=$DOMAIN
MINDDOCK_PUBLIC_URL=https://$DOMAIN
# 镜像标签：main 跟随最新提交；也可以固定为某个版本，如 0.2.0
MINDDOCK_TAG=main
MINDDOCK_SECRET_KEY=$(openssl rand -base64 32)
MINDDOCK_OPENLIST_ADMIN_PASSWORD=$(openssl rand -hex 16)
TZ=Asia/Shanghai
EOF
fi
umask 077
set_env MINDDOCK_MODE "$MODE"
if [ "$MODE" = direct ]; then
  set_env MINDDOCK_CADDYFILE Caddyfile.direct
  set_env MINDDOCK_HTTPS_BIND 443
  set_env MINDDOCK_HTTP_BIND 80
else
  # 宝塔模式用 compose 里的默认值（只监听本机）
  { grep -Ev '^MINDDOCK_(CADDYFILE|HTTPS_BIND|HTTP_BIND)=' .env || true; } > .env.tmp && mv .env.tmp .env
fi
chmod 600 .env

say "数据目录"
mkdir -p data/panel data/openlist data/caddy/data data/caddy/config
chown -R 10001:10001 data/panel
chown -R 1001:1001 data/openlist

say "检查域名解析"
public_ip=$(curl -s -4 --max-time 5 ifconfig.me || true)
resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
if [[ " $resolved " != *" $public_ip "* ]]; then
  die "域名 $DOMAIN 解析到 [${resolved:-无}]，本机公网 IP 为 $public_ip。请先添加 A 记录再运行。"
fi

# ---- 对外入口 ----

if [ "$MODE" = bt ]; then
  say "宝塔 nginx：80 端口转给 Caddy（证书验证与跳转 HTTPS）"
  site_conf="$BT_NGINX/$DOMAIN.conf"
  if [ -f "$site_conf" ]; then
    echo "已存在 $site_conf（可能已在宝塔中添加为网站），保持不变"
  elif [ -d "$BT_NGINX" ]; then
    sed "s/__DOMAIN__/$DOMAIN/g" deploy/nginx-site.conf > "$site_conf"
    nginx -t && nginx -s reload
  else
    echo "未找到宝塔 nginx，请自行把 80 端口反向代理到 127.0.0.1:8081" >&2
  fi

  say "宝塔 nginx：443 端口按域名分流给 Caddy"
  sni_conf="$BT_NGINX/tcp/sni_443.conf"
  holder=$(ss -Hltnp 'sport = :443' | grep -v nginx || true)
  if [ -f "$sni_conf" ]; then
    grep -q "$DOMAIN" "$sni_conf" || echo "请在 $sni_conf 的 map 中加入一行：$DOMAIN 127.0.0.1:8443;" >&2
  elif [ -n "$holder" ]; then
    echo "443 端口被其他程序占用，请把它改为监听本机其他端口，再参照 deploy/nginx-sni-443.conf 写入 $sni_conf" >&2
  elif [ -d "$(dirname "$sni_conf")" ]; then
    sed "s/__DOMAIN__/$DOMAIN/g" deploy/nginx-sni-443.conf > "$sni_conf"
    nginx -t && nginx -s reload
  else
    echo "未找到宝塔 nginx，请自行把 443 端口的连接（PROXY protocol）转发到 127.0.0.1:8443" >&2
  fi
fi

say "防火墙放行 80/443"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi

# ---- 恢复与备份密钥 ----

say "拉取镜像"
docker compose pull

if [ -n "$RESTORE" ]; then
  say "从备份恢复：$RESTORE"
  tag=$(grep '^MINDDOCK_TAG=' .env | cut -d= -f2- || true)
  printf '%s\n' "$IDENTITY" | docker run --rm -i \
    -v "$DIR/data/panel:/data" -v "$RESTORE:/restore/backup.age:ro" \
    "ghcr.io/tianyin231/minddock:${tag:-main}" python -m minddock restore /restore/backup.age
  unset IDENTITY
  # 加密主密钥、备份公钥等沿用旧服务器的；域名与入口模式以这次安装为准
  for key in MINDDOCK_SECRET_KEY MINDDOCK_OPENLIST_ADMIN_PASSWORD MINDDOCK_BACKUP_RECIPIENT MINDDOCK_TAG TZ; do
    value=$(grep "^$key=" data/panel/restored.env | cut -d= -f2- || true)
    if [ -n "$value" ]; then set_env "$key" "$value"; fi
  done
  chmod 600 .env
  rm -f data/panel/restored.env
  docker compose pull -q
fi

bash deploy/backup.sh --key-only

# ---- 启动 ----

say "启动"
docker compose up -d --remove-orphans

say "同步 OpenList 管理员密码"
for _ in $(seq 1 30); do
  if docker compose exec -T openlist ./openlist admin set "$(grep ^MINDDOCK_OPENLIST_ADMIN_PASSWORD= .env | cut -d= -f2)" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

say "等待面板启动"
code=""
for _ in $(seq 1 20); do
  logs=$(docker compose logs panel 2>/dev/null || true)
  code=$(grep -o '初始化码：[A-Z0-9-]*' <<<"$logs" | tail -1 || true)
  if [ -n "$code" ] || grep -q "Application startup complete" <<<"$logs"; then
    break
  fi
  sleep 2
done

say "完成：https://$DOMAIN"
if [ -n "$RESTORE" ]; then
  echo "已从备份恢复，用原来的账号登录。还需要你确认："
  echo "  1. 旧服务器上的 MindDock 已经停止（cd /opt/minddock && docker compose down），否则两边会同时收 QQ 消息"
  echo "  2. 如果在 QQ 开放平台设置了 IP 白名单，把本机 IP $public_ip 加进去"
  echo "  3. 已上传夸克的原件会在需要时自动从夸克取回，不用另外搬"
elif [ -n "$code" ]; then
  echo "首次打开面板时需要的 $code"
fi
for key in /root/minddock-backup-key*.txt; do
  if [ -f "$key" ]; then
    printf '\033[1;33m提醒：备份私钥还在 %s，存进密码管理器后请删除它\033[0m\n' "$key"
  fi
done
