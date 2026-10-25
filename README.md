# MindDock

**随身、安全、分门别类的第二大脑。**

在 QQ 里像给自己发消息一样发送文字、网址、图片、视频、文件和密钥，MindDock 自动去重、整理，归入笔记、收藏、待办、提醒、密钥、文件等分区，到点通过 QQ 提醒；原件归档到夸克网盘；在网页面板上实时看到归类过程并统一管理，密钥需要二次验证加二级密码才能查看。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度

- [x] 设计方案 v2.1
- [x] 后端骨架：配置、SQLite 迁移（完整数据结构）、健康检查、前端托管
- [x] 前端原型：总览、七个分区页面、详情抽屉、实时归类动画、深色模式、手机布局（分区内容暂为演示数据）
- [x] 账号体系：一次性初始化码、密码 + 新设备验证码（TOTP）、信任设备 30 天、登录限速
- [x] 面板设置：QQ 机器人、AI 模型、夸克网盘、邮件通知，密钥加密保存，每项可测试连接
- [x] 部署：Docker 镜像由 GitHub Actions 构建，服务器拉取更新
- [x] M0 第 1 步：QQ 收件闭环（绑定主人、回执、AI 归类与时间解析、面板真实数据与实时动画）
- [x] M0 第 2 步（上）：到点提醒（优先回复你最近的消息，其次 QQ 主动消息，再兜底邮件）、重复提醒、QQ 内 /done /later /提醒、面板完成 / 延后 / 改时间
- [x] M0 第 2 步（下）：密钥库（浏览器端加解密、二级密码与恢复码、#key 与自动识别加密入库、附件加密、面板新增 / 移出 / 改密码）
- [x] M0 第 3 步：原件自动上传夸克（核对大小、失败重试与告警）、图片缩略图、本地暂存保留 7 天后清理、清理后从夸克取回

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

首次打开会进入初始化页，初始化码打印在后端日志里。收消息和 AI 整理需要另外启动 `python -m minddock bot` 和 `python -m minddock worker`。

只调界面、不想启动后端时，可以用演示数据：`VITE_DEMO=1 npm run dev`。收件台页的"模拟一条"会触发一条新消息，用来观察归类动画；也可以直接在收件台的输入框里写一条。

## 部署

镜像由 GitHub Actions 构建并发布到 `ghcr.io/tianyin231/minddock`：推送 `main` 生成 `main` 标签，打 `v0.2.0` 这样的 git 标签生成 `0.2.0` 和 `latest`，每次提交另有 `sha-xxxxxxx` 标签便于回滚。

```bash
# 首次部署（root；域名需已解析到本机。缺 Docker 会自动安装）
curl -fsSL https://raw.githubusercontent.com/tianyin231/MindDock/main/deploy/install.sh | bash -s -- minddock.example.com

# 之后更新
bash /opt/minddock/deploy/update.sh
```

`install.sh` 会生成 `/opt/minddock/.env`（加密主密钥等，只在服务器上），按服务器情况选择入口模式，并启动面板、OpenList 和 Caddy。面板地址为 `https://<域名>`。QQ 机器人、AI 模型、夸克网盘、邮件通知都在面板的"设置"页填写。

| 入口模式 | 何时使用 | 做法 |
| --- | --- | --- |
| 独立模式 `direct` | 干净的服务器，80 / 443 空闲 | Caddy 直接监听 80 / 443，自动申请证书 |
| 宝塔模式 `bt` | 装有宝塔，443 还要分给其他服务 | 宝塔 nginx 把 80 转给 Caddy，把 443 上本域名的连接按 SNI 转给 Caddy |

默认自动选择（有宝塔用宝塔模式，否则独立模式），也可以用 `--mode direct` 或 `--mode bt` 指定；选择结果记在 `.env` 的 `MINDDOCK_MODE`，之后重复运行保持不变。

宝塔模式下，443 由 nginx 的四层配置 `/www/server/panel/vhost/nginx/tcp/sni_443.conf` 按域名分流，只转发、不解密，证书由 Caddy 自动申请和续期（Let's Encrypt）。因此宝塔里的网站不能再直接开启 443 的 SSL，否则会与分流冲突；需要时在该文件的 map 中为域名加一条转发。

在宝塔中管理：容器在"Docker → 容器编排"里显示为 `minddock`；域名可以在"网站 → Docker"里添加为反向代理网站（目标容器 `minddock-caddy-1`，端口 8081），代替 install.sh 写入的 nginx 配置。

忘记密码或丢失验证器时，在服务器上删除登录账号（笔记、设置等内容不受影响），再按日志里的新初始化码重新创建：

```bash
cd /opt/minddock
docker compose exec panel python -m minddock reset-account
docker compose restart panel && sleep 5 && docker compose logs panel | grep 初始化码
```
