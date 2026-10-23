# MindDock

**随身、安全、分门别类的第二大脑。**

在 QQ 里像给自己发消息一样发送文字、网址、图片、视频、文件和密钥，MindDock 自动去重、整理，归入笔记、收藏、待办、提醒、密钥、文件等分区，到点通过 QQ 主动提醒；原件归档到夸克网盘；在网页面板上实时看到归类过程并统一管理，密钥需要二次验证加二级密码才能查看。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度

- [x] 设计方案 v2.1
- [x] 后端骨架：配置、SQLite 迁移（完整数据结构）、健康检查、前端托管
- [x] 前端原型：总览、七个分区页面、详情抽屉、实时归类动画、深色模式、手机布局（分区内容暂为演示数据）
- [x] 账号体系：一次性初始化码、密码 + 新设备验证码（TOTP）、信任设备 30 天、登录限速
- [x] 面板设置：QQ 机器人、AI 模型、夸克网盘、邮件通知，密钥加密保存，每项可测试连接
- [x] 部署：Docker 镜像由 GitHub Actions 构建，服务器拉取更新
- [ ] M0：QQ 收件、AI 归类、提醒、密钥库、上传夸克、分区接入真实数据

## 目录

```text
server/   Python 后端（uv 项目，FastAPI + SQLite）
web/      React 前端（Vite + Tailwind CSS + shadcn/ui + Motion）
docs/     设计文档
```

## 本地开发

需要 [uv](https://docs.astral.sh/uv/) 和 Node.js 22 及以上版本。

```bash
# 后端（本地是 http，需关闭 Cookie 的 Secure 标记）
cd server
uv run pytest
MINDDOCK_COOKIE_SECURE=false uv run python -m minddock panel   # http://127.0.0.1:8080

# 前端
cd web
npm install
npm run dev      # http://127.0.0.1:5173，接口请求转发到 8080
```

首次打开会进入初始化页，初始化码打印在后端日志里。分区内容目前是内存里的演示数据（`web/src/api/mock/`），总览页的"模拟一条"可以触发一条新消息，观察归类动画。

## 部署

镜像由 GitHub Actions 构建并发布到 `ghcr.io/tianyin231/minddock`：推送 `main` 生成 `main` 标签，打 `v0.2.0` 这样的 git 标签生成 `0.2.0` 和 `latest`，每次提交另有 `sha-xxxxxxx` 标签便于回滚。

```bash
# 首次部署（root，服务器需已安装 Docker；域名需已解析到本机）
git clone https://github.com/tianyin231/MindDock.git /opt/minddock
bash /opt/minddock/deploy/install.sh minddock.example.com

# 之后更新
bash /opt/minddock/deploy/update.sh
```

`install.sh` 会生成 `/opt/minddock/.env`（加密主密钥等，只在服务器上），配置宝塔 nginx 转发证书验证，并启动面板、OpenList 和 Caddy。面板地址为 `https://<域名>:8443`。QQ 机器人、AI 模型、夸克网盘、邮件通知都在面板的"设置"页填写。
