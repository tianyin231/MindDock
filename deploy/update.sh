#!/usr/bin/env bash
# 更新到 .env 中 MINDDOCK_TAG 指定的版本：拉代码（编排与脚本）、拉镜像、重启
set -euo pipefail
cd /opt/minddock

git pull --ff-only
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f >/dev/null

sleep 3
docker compose ps
docker compose exec -T panel python -c \
  "import json, urllib.request; h = json.load(urllib.request.urlopen('http://127.0.0.1:8080/api/health')); print('当前版本:', h['version'], h['build'], h['commit'])"
