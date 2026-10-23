# MindDock

**随身、安全、分门别类的第二大脑。**

在 QQ 里像给自己发消息一样发送文字、网址、图片、视频、文件和密钥，MindDock 自动去重、整理，归入笔记、收藏、待办、提醒、密钥、文件等分区，到点通过 QQ 主动提醒；原件归档到夸克网盘；在网页面板上实时看到归类过程并统一管理，密钥需要二次验证加二级密码才能查看。

完整设计见 [docs/design.md](docs/design.md)。

## 当前进度

- [x] 设计方案 v2.1
- [x] 后端骨架：配置、SQLite 迁移（完整数据结构）、健康检查、前端托管
- [x] 前端原型：总览、七个分区页面、详情抽屉、实时归类动画、深色模式、手机布局（目前使用演示数据）
- [ ] 第 3 步验证：QQ 机器人、OpenList + 夸克、AI 接口
- [ ] M0：QQ 收件、AI 归类、提醒、密钥库、上传夸克、面板接入真实接口

## 目录

```text
server/   Python 后端（uv 项目，FastAPI + SQLite）
web/      React 前端（Vite + Tailwind CSS + shadcn/ui + Motion）
docs/     设计文档
```

## 本地开发

需要 [uv](https://docs.astral.sh/uv/) 和 Node.js 22 及以上版本。

```bash
# 后端
cd server
uv run pytest                      # 测试
uv run python -m minddock panel    # 启动面板接口，默认 http://127.0.0.1:8080

# 前端
cd web
npm install
npm run dev                        # 开发服务器，接口请求转发到 8080
npm run build                      # 构建到 web/dist，由后端托管
```

前端目前接的是内存里的演示数据（`web/src/api/mock/`），总览页的"模拟一条"按钮可以手动触发一条新消息，观察归类动画。
