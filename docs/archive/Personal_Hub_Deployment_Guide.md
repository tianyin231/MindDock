# Personal Hub：私人信息收件箱与 AI 第二大脑

> **部署与扩展实施方案 · v1.0**
> **编制日期：2026-10-20**
> **实施环境：已有 Linux 云服务器；暂不购买 NAS；对象存储采用 Cloudflare R2**

**一句话目标**：像“给自己发消息”一样随手记录文字、网址、图片、视频与文件；原件长期保存，跨设备访问；以后在原始资料之上增加自动归档、智能检索与 AI 关联能力。高敏感凭据始终单独加密管理。

## 1. 实施结论

第一版选择 **Memos 0.31.0 + Cloudflare R2 Standard + Docker Compose + Tailscale Serve**。Memos 负责记录、搜索和账户控制；R2 保存新上传的附件；SQLite 保存笔记及附件元数据；Tailscale 将 Memos 以私有 HTTPS 地址交给自己的设备访问。**KeePassXC** 单独管理 API Key、SSH 私钥与恢复码。

第一版不部署 PostgreSQL、Redis、向量数据库和常驻 AI Agent；不把对象存储当数据库硬盘；不将 Memos 端口或 R2 Bucket 公开至互联网。

| 需求 | 第一版能否实现 | 说明 |
| --- | --- | --- |
| 快速写想法、备忘录、待办 | 是 | Memos 时间线、Markdown、标签与搜索 |
| 保存图片、PDF、文件 | 是 | 附件写入私有 R2 Bucket；先验证原件读取 |
| 存储视频 | 有条件 | 受 Memos 上传限制、云服务器传输链路与客户端影响，需实测 |
| 手机、Windows、macOS 访问 | 是 | 浏览器 + Tailscale；浏览器共享/快捷方式另行配置 |
| 系统分享菜单一键发送 | 部分 | 可能需快捷指令、第三方扩展或自研轻量入口 |
| 断网自动缓存与补传 | 不保证 | 作为第二阶段独立实现，不宣称 Memos 原生可用 |
| AI 自动分类、OCR、相似想法关联 | 后续实现 | Python Worker + 检索索引，原始记录不被 AI 覆盖 |
| 自动保存与读取明文密钥 | 不纳入笔记库 | 改用独立 KeePassXC 加密保险库 |

## 2. 第一版系统架构

```text
手机 / Windows / macOS / 浏览器
            │
            │  Tailscale 私有网络（HTTPS）
            ▼
┌──────────────────────────────┐
│      现有 Linux 云服务器      │
│  ┌────────────────────────┐  │
│  │ Memos 0.31.0 (Docker) │  │
│  │ SQLite: 笔记/附件元数据 │  │
│  └────────────────────────┘  │
│            │ S3 API           │
└────────────┼─────────────────┘
             ▼
       Cloudflare R2
       私有 Standard Bucket
       图片 / 视频 / 文档附件

独立安全区：KeePassXC 加密数据库（不进入 Memos 与 AI 索引）
独立备份：SQLite 在线备份 + R2 文件副本 + 异地加密备份
```

**数据路径**：用户提交笔记 → Memos 存文本和附件关系 → Memos 通过 S3 接口存取 R2 附件 → 用户经 Memos 的授权文件路由查看或下载。当前 Memos 的受管 S3 文件经应用鉴权代理，不能简单等同于“手机直接从 R2 下载”；大视频的直接上传功能应留到后期独立实现。

**为什么先用 SQLite**：单人/少量用户的元数据量小，运维简单；图片视频已分离到 R2。到多设备多用户高并发、复杂索引需求明显时，再评估 PostgreSQL。

## 3. 软硬件和前置条件

- 云服务器：建议 Linux x86-64 或 ARM64、Docker Engine 与 Compose 插件；至少留出系统、日志、SQLite、备份的磁盘余量。起步建议按 **2 vCPU / 2 GB RAM** 规划，不是软件官方硬性下限。
- 软件：Docker、Docker Compose、Tailscale（安装于云服务器宿主机）、`sqlite3`、`curl`。
- 账户：Cloudflare 账号并开通 R2；R2 需要启用相关计费服务，即便使用免费额度也应设预算提醒。
- 终端：手机、Windows、macOS 安装 Tailscale 客户端；普通浏览器即可使用 Memos。
- 隐私假设：云服务器和 Memos 在运行时有能力读取普通笔记及附件；R2 私有 Bucket 不等于端到端加密。秘密凭据不存笔记库。

### Cloudflare R2 的费用边界

截至 2026-10-20，R2 **Standard** 的月度免费额度为 **10 GB-month 存储、100 万次 A 类请求、1000 万次 B 类请求，公网出口流量免费**。超过配额按现行价格计费；Infrequent Access 不适用这项免费额度。容量 10 GB 只适合少量视频与大量日常截图的初期阶段，不是无限免费存储。

## 4. 云服务器部署 Memos

以下命令以 Ubuntu/Debian 系 Linux 为例，默认把工程放在 `/opt/personal-hub`。执行之前应确认已有 Docker 与 Compose 插件；如服务器已运行其他服务，请先检查端口和资源占用。

### 4.1 初始化目录

```bash
sudo mkdir -p /opt/personal-hub/data/memos /opt/personal-hub/backups
cd /opt/personal-hub
```

把随附的 `compose.yaml` 复制到该目录。核心配置如下：

```yaml
services:
  memos:
    image: neosmemo/memos:0.31.0
    container_name: personal-hub-memos
    restart: unless-stopped
    ports:
      - "127.0.0.1:5230:5230"
    volumes:
      - ./data/memos:/var/opt/memos
```

这里使用明确版本 `0.31.0`，避免 `stable` 标签更新时出现未经检查的升级。`127.0.0.1` 限制只有服务器本机进程能访问 5230 端口，远程访问通过下一节的 Tailscale Serve 完成。

### 4.2 启动和检查

```bash
cd /opt/personal-hub
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 memos
curl -I http://127.0.0.1:5230
```

服务首次初始化后，创建管理员账户。首先确认：实例访问策略为 **PRIVATE**、关闭不需要的公开注册、禁用不打算使用的公开分享；普通记录默认设为 PRIVATE。**Memos 0.31 的 PRIVATE 策略和 `MEMOS_INSTANCE_URL` 是两项独立设置**，不能误以为填了某个 URL 就自动设为私有。

## 5. 远程访问：Tailscale 私有 HTTPS

建议在宿主机安装 Tailscale，并将服务器、手机和电脑加入自己的 tailnet。安装方式随发行版变化，以 Tailscale 官方安装文档为准。

```bash
# 完成 Tailscale 的官方安装之后
sudo tailscale up
sudo tailscale status
# 在 tailnet 中为本地 Memos 开启私有 HTTPS 代理
sudo tailscale serve --bg 5230
sudo tailscale serve status
```

在 Tailscale 管理后台根据提示开启 HTTPS 证书，记录 Serve 显示的真实私有 URL（通常为 `https://设备名.tailnet域名.ts.net`）。登录 Memos 后把 `MEMOS_INSTANCE_URL` 配成最终实际地址——是否以容器环境变量配置，按 Memos 当前官方文档执行——并再次确认 ACCESS=PRIVATE。

**访问原则**：只用 Tailscale Serve，**不要用 Funnel**（后者面向公网公开服务）；云服务器防火墙不需要为 Memos 开放 TCP 5230。只有加入 tailnet 且满足其访问控制策略的设备才能进入网络，Memos 本身还需要账号认证。

如果将来特别希望只使用 Cloudflare 服务，可以评估 **Cloudflare Tunnel + Access** 作为替代入口，但它需要另行设置域名、身份验证和访问策略；第一版不必增加两套入口。

## 6. Cloudflare R2：创建私有附件仓库

### 6.1 创建 Bucket

进入 Cloudflare Dashboard → **Storage & databases → R2**，先完成 R2 开通流程。

创建 Bucket，例如 `personal-hub-media`：

- 存储类别选择 **Standard**，确保能够使用 Standard 免费额度。
- 保持 **Private**，不要打开 `r2.dev` 公共访问，也不要绑定公开自定义域名。
- 选择适合的位置；一旦上线，优先按合规与传输延迟选区，而不是只看容量。

### 6.2 创建最小权限的 S3 凭据

R2 管理页面 → API Tokens → Create API Token。创建独立给 Memos 使用的凭据：

- 权限：Object Read & Write；
- 范围：只授权 `personal-hub-media` 这一个 Bucket；
- 记录 **Access Key ID** 和 **Secret Access Key**，Secret 只在创建时显示；
- 不要把密钥放进代码仓库、截图或公开文档。

S3 Endpoint 格式：

```text
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

使用 region=`auto`。这里的 `<ACCOUNT_ID>` 是占位符，不是实际账号 ID。

### 6.3 在 Memos 管理界面设置存储

Memos 0.31 的附件存储通常通过**实例管理设置**配置，而不是把旧版本的 `MEMOS_STORAGE_TYPE=s3` 当成通用启动参数。

在管理员界面找到 Storage / 存储设置，新增命名存储配置：

| 字段 | 建议填写 |
| --- | --- |
| 名称 / ID | `r2-primary` |
| 类型 | S3-compatible / S3 |
| Endpoint | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| Region | `auto` |
| Bucket | `personal-hub-media` |
| Access Key | 仅授权此 Bucket 的 R2 Access Key ID |
| Secret Key | 对应 R2 Secret Access Key |
| Path style | 先按官方推荐默认值；若测试失败再依兼容文档调整 |
| 默认新附件存储 | 选择 `r2-primary` |

配置保存后，用少量文件做完整的上传、预览与下载回归测试。**切换默认存储不会自动搬迁之前上传的附件**；不要删除仍被旧附件引用的存储配置。

### 6.4 上线前测试

- 新建 1 条纯文字笔记，重启容器后仍能搜索到。
- 上传一张原图和一个 PDF，下载后比较哈希与大小，确认不是仅保存了压缩预览。
- 上传一个短视频，验证上传大小限制、播放与 Range 请求；如超出限制，优先调整产品流程，不盲目扩大反向代理限制。
- 在匿名浏览器或未加入 tailnet 的设备上确认无法打开私人笔记与附件。
- 查看 R2 Bucket 的对象数量和用量确实增加。

## 7. 高敏感凭据：独立 KeePassXC

不要在普通 Memos 笔记里粘贴 API Key、SSH 私钥、登录恢复码或其他能直接访问生产环境的秘密。AI OCR、全文索引、日志、数据库备份和管理账户都可能接触笔记明文。

采用独立 **KeePassXC** `.kdbx` 加密数据库保存密钥。先在个人电脑本地创建数据库，设置强主密码，跨设备同步时只同步加密文件；必要时增加独立密钥文件，并把密钥文件与数据库分开保管。做至少一份离线备份，定期验证能在另一台设备解锁。程序需要自动用密钥时，应另行设计专门的 Secrets Manager，而不是解析笔记库。

## 8. 备份与灾难恢复

**R2 不是备份，RAID 也不是备份。** 完整恢复依赖三个部分：① SQLite 笔记数据库；② R2 附件对象；③ 应用版本、配置、存储凭据与访问策略。

### 8.1 每日 SQLite 在线备份

随附 `backup-memos.sh` 使用 SQLite 的 `.backup` 在线备份接口，避免直接复制正在写入的数据库而造成不一致；会执行完整性检查并保留 14 天本地备份。

```bash
sudo apt-get update && sudo apt-get install -y sqlite3
sudo chmod +x /opt/personal-hub/backup-memos.sh
sudo /opt/personal-hub/backup-memos.sh
```

通过 root 的 cron 安排每日备份（示例北京时间前后以服务器时区为准）：

```bash
15 3 * * * /opt/personal-hub/backup-memos.sh >> /var/log/personal-hub-backup.log 2>&1
```

本地备份只是第一层。必须将数据库快照**加密复制到与原 VPS 不同的故障域**，例如离线电脑/硬盘或第二个存储位置。R2 对象也应定期同步出一个独立副本。为防误删除，备份应尽量采用带历史版本的追加式策略，而非单纯覆盖式同步。

### 8.2 最小恢复演练

1. 在隔离环境准备相同版本的 Memos 容器；
2. 恢复 SQLite 数据库，验证 `PRAGMA integrity_check`；
3. 确认 R2 Bucket 与原有命名存储 ID、凭据仍可访问；
4. 恢复附件副本（如原 Bucket 失效），再检查相关存储配置与对象 Key；
5. 随机抽取旧笔记、图片和视频进行打开、下载与哈希检查。

重要：Memos 个人账户的 Export & Import 很适合迁移/保存个人笔记，但**不等于完整实例备份**；账户、权限与全部实例配置仍依赖真正的备份策略。

## 9. 第二阶段：全平台收件箱增强

第一版直接使用 Memos 网页或剪藏工具。若发现日常发送仍然繁琐，再开发一个“轻量投递层”，而不是重新开发整个笔记产品。

建议顺序：

1. **Android 系统分享菜单**：从图片、网页、相册、文本选择“发送到 Personal Hub”；
2. **Windows/macOS 全局快捷键**：弹出 1 个短输入框，支持粘贴剪贴板图片；
3. **离线队列**：本地持久化 `pending → uploading → confirmed` 状态，支持重试、幂等键与续传；
4. **大文件直传**：由自建投递 API 验证用户身份后签发 R2 短时效预签名上传 URL，客户端直接上传原件，再提交元数据；
5. **跨设备确认**：客户端只在服务端持久化且校验完毕后显示“归档成功”。

对 R2 预签名 URL，设置合理时效、指定对象 Key 与预期 Content-Type；浏览器直传还需配置精确的 CORS Origin。预签名 URL 不是永久授权，也不能直接把 R2 Secret Key 发给手机。

## 10. 第三阶段：AI 第二大脑

不要从零搭建一个无限自主运行的 Agent。先增加可重复执行的归档流水线：

```text
新笔记 / 新附件
  → 入站事件（保存 item_id 与幂等键）
  → 可重试后台任务
  → 文本提取 / 图片 OCR / 音视频转写（按需）
  → 自动标签、标题和摘要（仅处理非敏感数据）
  → 全文索引 + Embedding 向量
  → 关联推荐（相关想法、参考资料、所属项目）
  → 搜索与 AI 问答（返回笔记 ID 和来源）
```

数据建模尽量保持独立：

- `items`：原始输入、来源、时间、所属项目和可见性；
- `attachments`：对象 Key、SHA-256、大小、原始 MIME、所属笔记；
- `derived`：OCR、摘要、标签、模型版本、生成时间；
- `relations`：项目关联、引用、相似、后续行动；
- `jobs`：任务状态、重试次数、失败原因。

建议先做全文搜索与自动标签，明显需要自然语言检索之后再引入 PostgreSQL + pgvector。AI 生成的标签和关联单独存储，**不得覆盖原始笔记**。高敏感凭据、私密档案与密码库不进入自动 AI 管道。

## 11. 安全基线与运维检查

| 项目 | 最低要求 |
| --- | --- |
| 网络 | 5230 只绑定回环地址；Tailscale Serve 不使用 Funnel |
| Memos | 私有实例，关闭不需要的公开注册与分享，强管理员密码 |
| R2 | Bucket 保持私有；凭据仅授予单 Bucket；定期轮换 |
| 凭据 | 不写进 Git；不得粘贴进 AI 提示词与普通笔记 |
| 系统 | SSH 最小暴露、及时安全更新、必要时限制登录来源 |
| 数据 | SQLite 每日快照、R2 独立副本、异地加密备份 |
| 费用 | 关注 R2 GB-month、A/B 请求数和云服务器流量 |
| 变更 | 更新 Memos 前先备份，测试回滚及附件可访问性 |
| 恢复 | 每月抽样恢复一次数据库和若干附件 |

## 12. 里程碑与验收清单

| 阶段 | 交付范围 | 验收标准 |
| --- | --- | --- |
| M0：基础上线 | Memos Docker、Tailscale、R2 私有存储 | 手机和电脑均可写入、查看、下载文件 |
| M1：可靠使用 | 完整备份、错误监控、使用习惯固化 | 重启不丢数据，恢复演练成功 |
| M2：快捷投递 | 分享菜单、快捷键、离线队列 | 提交方便、无重复入库、断网可补传 |
| M3：自动归档 | OCR、元数据提取、去重、规则分类 | 不改原件，可按关键词与标签找回 |
| M4：第二大脑 | 向量检索、RAG、关联与回顾 | 模糊提问能返回可核查的原始记录 |
| M5：扩容迁移 | NAS/多存储后端与对象同步 | 迁移不更换主键、不丢附件引用 |

## 13. 当前应完成的第一批任务

**本周只做 M0 + M1 最小闭环**：部署容器 → 创建私有管理员 → 配置私有 Tailscale URL → 配置 R2 Storage → 测试原件上传和下载 → 设置 SQLite 定时备份 → 保存独立的 R2 附件备份 → 用另一台设备完成恢复抽测。

**暂缓**：多系统并行、多个免费存储服务拼接、自动重排文件夹、全量 AI 向量化、视频转写、大型 NAS 采购、公开分享接口。

## 14. 官方参考资料（2026-10-20 核对）

1. Memos Getting Started：https://usememos.com/docs/getting-started
2. Memos Storage：https://usememos.com/docs/configuration/storage
3. Memos Security：https://usememos.com/docs/configuration/security
4. Memos Backup & Restore：https://usememos.com/docs/operations/backup-restore
5. Memos Export & Import：https://usememos.com/docs/usage/export-import
6. Memos Release / Upgrade 0.31：https://usememos.com/docs/operations/upgrade
7. Cloudflare R2 S3：https://developers.cloudflare.com/r2/get-started/s3/
8. Cloudflare R2 Pricing：https://developers.cloudflare.com/r2/pricing/
9. Cloudflare R2 Presigned URLs：https://developers.cloudflare.com/r2/api/s3/presigned-urls/
10. Tailscale Serve：https://tailscale.com/docs/reference/tailscale-cli/serve
11. KeePassXC：https://keepassxc.org/

---

**维护原则**：文档中所有令牌、域名、Bucket、账号 ID 仅为示例；实际部署时将真实密钥保存在安全保险库。此文档为实施蓝图和起步配置，具体软件功能、Cloudflare 免费额度和操作路径应以部署时的官方页面为准。
