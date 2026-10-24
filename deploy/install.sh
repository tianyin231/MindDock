#!/usr/bin/env bash
# 首次部署（以 root 运行，可重复执行）：
#   curl -fsSL https://raw.githubusercontent.com/tianyin231/MindDock/main/deploy/install.sh | bash -s -- minddock.example.com
# 或在已克隆的仓库里：bash deploy/install.sh minddock.example.com
set -euo pipefail

DOMAIN="${1:?用法：install.sh <域名>}"
DIR=/opt/minddock
REPO=https://github.com/tianyin231/MindDock.git

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

say "代码：$DIR"
if [ ! -d "$DIR/.git" ]; then
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
git pull --ff-only

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
chmod 600 .env

say "数据目录"
mkdir -p data/panel data/openlist data/caddy/data data/caddy/config
chown -R 10001:10001 data/panel
chown -R 1001:1001 data/openlist

say "检查域名解析"
public_ip=$(curl -s -4 --max-time 5 ifconfig.me || true)
resolved=$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ')
if [[ " $resolved " != *" $public_ip "* ]]; then
  echo "域名 $DOMAIN 解析到 [${resolved:-无}]，本机公网 IP 为 $public_ip。请先添加 A 记录再运行。" >&2
  exit 1
fi

say "宝塔 nginx：80 端口转给 Caddy（证书验证与跳转 HTTPS）"
site_conf="/www/server/panel/vhost/nginx/$DOMAIN.conf"
if [ -f "$site_conf" ]; then
  echo "已存在 $site_conf（可能已在宝塔中添加为网站），保持不变"
elif [ -d /www/server/panel/vhost/nginx ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" deploy/nginx-site.conf > "$site_conf"
  nginx -t && nginx -s reload
else
  echo "未找到宝塔 nginx，请自行把 80 端口反向代理到 127.0.0.1:8081" >&2
fi

say "宝塔 nginx：443 端口按域名分流给 Caddy"
sni_conf=/www/server/panel/vhost/nginx/tcp/sni_443.conf
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

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 443/tcp >/dev/null
fi

say "拉取镜像并启动"
docker compose pull
docker compose up -d

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
if [ -n "$code" ]; then
  echo "首次打开面板时需要的 $code"
fi
