# MindDock 镜像：Node 阶段编译前端，Python 阶段运行后端并托管前端
# 由 GitHub Actions 构建并发布到 ghcr.io/tianyin231/minddock，服务器只拉取不编译

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build


FROM python:3.12-slim-bookworm AS app
COPY --from=ghcr.io/astral-sh/uv:0.13.5 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app/server
# 先只装依赖，代码变动时可复用这一层缓存
COPY server/pyproject.toml server/uv.lock server/.python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY server/ ./
COPY --from=web /web/dist /app/web/dist

ARG MINDDOCK_VERSION=dev
ARG MINDDOCK_COMMIT=""
ENV PATH="/app/server/.venv/bin:$PATH" \
    MINDDOCK_VERSION=$MINDDOCK_VERSION \
    MINDDOCK_COMMIT=$MINDDOCK_COMMIT \
    MINDDOCK_DATA_DIR=/data \
    MINDDOCK_WEB_DIST_DIR=/app/web/dist

RUN useradd --system --uid 10001 --no-create-home minddock && mkdir -p /data && chown minddock /data
USER minddock
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4)"
CMD ["python", "-m", "minddock", "panel", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
