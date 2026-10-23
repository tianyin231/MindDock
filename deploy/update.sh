#!/usr/bin/env bash
# 更新到 .env 中 MINDDOCK_TAG 指定的版本：拉代码（编排与脚本）、拉镜像、重启
set -euo pipefail
cd /opt/minddock

caddy_before=$(git rev-parse HEAD:deploy/Caddyfile)
git pull --ff-only
caddy_after=$(git rev-parse HEAD:deploy/Caddyfile)

docker compose pull
docker compose up -d --remove-orphans
# Caddyfile 是挂载进去的文件，内容变了容器不会自动重建，需要手动重启
if [ "$caddy_before" != "$caddy_after" ]; then
  docker compose restart caddy
fi
docker image prune -f >/dev/null

docker compose ps
# 等面板启动完成再读取版本，最多等 60 秒
for _ in $(seq 1 30); do
  if docker compose exec -T panel python -c \
    "import json, urllib.request; h = json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health')); print('当前版本:', h['version'], h['build'], h['commit'])" 2>/dev/null; then
    exit 0
  fi
  sleep 2
done
echo "面板 60 秒内没有就绪，请查看：docker compose logs panel" >&2
exit 1
