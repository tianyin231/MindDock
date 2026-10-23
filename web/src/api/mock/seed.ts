import type { Attachment, Item, ItemPartition, RepeatRule, Secret } from '../types'

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function makeCode(): string {
  let code = ''
  for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return code
}

export function makeId(): string {
  // randomUUID 只在安全上下文可用，getRandomValues 则到处可用
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const iso = (ms: number) => new Date(ms).toISOString()
const ago = (ms: number) => iso(Date.now() - ms)

/** 从今天起第 dayOffset 天的 hh:mm */
function dayAt(dayOffset: number, hh: number, mm = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hh, mm, 0, 0)
  return d.toISOString()
}

/** 下一次出现的 hh:mm（今天已过则为明天） */
function nextAt(hh: number, mm = 0): string {
  const today = new Date()
  today.setHours(hh, mm, 0, 0)
  return today.getTime() > Date.now() ? today.toISOString() : dayAt(1, hh, mm)
}

/** 下一个星期几（0 = 周日）的 hh:mm */
function nextWeekday(weekday: number, hh: number): string {
  const d = new Date()
  const diff = (weekday - d.getDay() + 7) % 7 || 7
  return dayAt(diff, hh)
}

function attachment(
  kind: Attachment['kind'],
  name: string,
  size: number,
  hue: number,
  uploadStatus: Attachment['uploadStatus'] = 'uploaded',
): Attachment {
  const mime = {
    image: 'image/jpeg',
    video: 'video/mp4',
    audio: 'audio/silk',
    file: name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
  }[kind]
  return { id: makeId(), kind, name, size, mime, uploadStatus, hue }
}

function item(partition: ItemPartition, fields: Partial<Item> & { text: string; title: string }): Item {
  const createdAt = fields.createdAt ?? ago(Math.random() * 3 * DAY)
  return {
    id: makeId(),
    code: makeCode(),
    source: 'qq',
    partition,
    partitionSource: 'auto',
    tags: [],
    attachments: [],
    ai: partition === 'inbox' ? undefined : { model: 'gpt-compatible', at: createdAt },
    ...fields,
    createdAt,
  }
}

function bookmark(url: string, title: string, summary: string, tags: string[], age: number): Item {
  const site = new URL(url).hostname.replace(/^www\./, '')
  return item('bookmark', {
    text: url,
    title,
    summary,
    tags,
    link: { url, site, title },
    createdAt: ago(age),
  })
}

function todo(title: string, dueAt: string | undefined, doneAt?: string, age = 6 * HOUR): Item {
  return item('todo', { text: title, title, todo: { dueAt, doneAt }, tags: [], createdAt: ago(age) })
}

function reminder(
  text: string,
  title: string,
  remindAt: string,
  repeat: RepeatRule,
  status: 'scheduled' | 'sent' = 'scheduled',
  channel?: 'qq' | 'email',
): Item {
  return item('reminder', {
    text,
    title,
    reminder: { remindAt, repeat, status, channel },
    createdAt: ago(2 * DAY * Math.random() + HOUR),
  })
}

function file(title: string, att: Attachment, tags: string[], age: number): Item {
  return item('file', { text: '', title, attachments: [att], tags, createdAt: ago(age) })
}

export function seedItems(): Item[] {
  return [
    // 笔记
    item('note', {
      text: '想法：MindDock 可以加一个每周回顾，把这周收藏的文章自动总结成一页，周日晚上推送给我。',
      title: '每周回顾功能',
      summary: '每周自动总结收藏内容并推送',
      tags: ['产品', '想法'],
      createdAt: ago(35 * MIN),
    }),
    item('note', {
      text: '读书笔记：《原则》——痛苦 + 反思 = 进步。遇到问题先别急着找借口，记录下来复盘，下次就会处理得更好。',
      title: '《原则》读书笔记',
      summary: '痛苦加反思等于进步',
      tags: ['读书'],
      createdAt: ago(5 * HOUR),
    }),
    item('note', {
      text: '和老王聊到：小团队做产品，先做出一个人愿意天天用的东西，再考虑规模。',
      title: '小团队做产品的原则',
      tags: ['思考'],
      createdAt: ago(26 * HOUR),
    }),
    item('note', {
      text: '周末徒步路线备选：香山 → 植物园，全程约 12 公里，记得带护膝和两瓶水。',
      title: '周末徒步路线',
      tags: ['生活', '徒步'],
      createdAt: ago(30 * HOUR),
    }),
    item('note', {
      text: 'Docker 镜像瘦身：多阶段构建 + slim 基础镜像，前端构建产物单独一层，依赖层放前面以便缓存。',
      title: 'Docker 镜像瘦身要点',
      tags: ['技术', 'Docker'],
      createdAt: ago(2 * DAY + 3 * HOUR),
    }),
    item('note', {
      text: '灵感：提醒消息里直接带上「完成」「延后 30 分钟」两个快捷回复，不用打开面板。',
      title: '提醒快捷回复',
      tags: ['产品'],
      createdAt: ago(3 * DAY),
    }),

    // 收藏
    bookmark(
      'https://sspai.com/post/90213',
      '我的效率工具箱：2026 年版',
      '作者分享了一年来留下的 12 款效率工具，以及它们之间如何配合。',
      ['效率'],
      50 * MIN,
    ),
    bookmark(
      'https://github.com/OpenListTeam/OpenList',
      'OpenList：支持多种存储的文件列表程序',
      'AList 的社区分支，可把百度、夸克等网盘挂载为 WebDAV。',
      ['开源', '网盘'],
      3 * HOUR,
    ),
    bookmark(
      'https://motion.dev/docs/react-layout-animations',
      'Layout animations | Motion',
      '用 layout 和 layoutId 实现布局与共享元素动画。',
      ['前端', '动画'],
      7 * HOUR,
    ),
    bookmark(
      'https://www.sqlite.org/fts5.html',
      'SQLite FTS5 Extension',
      'FTS5 全文检索扩展，trigram 分词器支持任意子串检索。',
      ['数据库'],
      20 * HOUR,
    ),
    bookmark(
      'https://www.zhihu.com/question/second-brain',
      '如何搭建自己的「第二大脑」？',
      '从收集、整理、提炼到表达，介绍个人知识管理的完整流程。',
      ['知识管理'],
      28 * HOUR,
    ),
    bookmark(
      'https://ui.shadcn.com',
      'shadcn/ui — 精心设计的组件集合',
      '可复制进项目、自由修改的 React 组件。',
      ['前端'],
      2 * DAY,
    ),
    bookmark(
      'https://www.bilibili.com/video/BV1docker',
      '30 分钟入门 Docker Compose',
      '从单容器到多服务编排的入门视频。',
      ['技术', '视频'],
      2 * DAY + 5 * HOUR,
    ),
    bookmark(
      'https://developers.cloudflare.com/r2/pricing/',
      'Cloudflare R2 定价',
      '标准存储每月 10 GB 免费额度，出口流量免费。',
      ['云服务'],
      3 * DAY,
    ),

    // 待办
    todo('续费海外服务器', dayAt(0, 18), undefined, 3 * HOUR),
    todo('整理 10 月发票', dayAt(-2, 20), undefined, 3 * DAY),
    todo('备份一次夸克 cookie 到 KeePassXC', dayAt(1, 21), undefined, 9 * HOUR),
    todo('买猫粮、洗衣液、电池', undefined, undefined, 2 * HOUR),
    todo('预约年度体检', dayAt(5, 10), undefined, DAY),
    todo('回复 QQ 开放平台的审核邮件', dayAt(0, 12), ago(4 * HOUR), 8 * HOUR),
    todo('更新 KeePassXC 离线备份', dayAt(-1, 22), ago(20 * HOUR), 2 * DAY),

    // 提醒
    reminder('一个半小时后提醒我交季度报告', '交季度报告', iso(Date.now() + 90 * MIN), 'none'),
    reminder('每天早上 8 点提醒我喝水', '喝一杯水', nextAt(8), 'daily'),
    reminder('每周一上午 10 点周会', '周会', nextWeekday(1, 10), 'weekly'),
    reminder('下周三晚上 7 点给妈妈打电话，她生日', '给妈妈打电话（生日）', dayAt(6, 19), 'none'),
    reminder('昨天早上 7 点提醒我体检空腹', '体检前空腹', dayAt(-1, 7), 'none', 'sent', 'qq'),
    reminder('每月 20 号提醒交房租', '交房租', dayAt(-3, 9), 'monthly', 'sent', 'email'),

    // 文件
    file('徒步山顶合影', attachment('image', 'IMG_20261021_山顶.jpg', 4_200_000, 150), ['徒步'], 20 * MIN),
    file('报错截图', attachment('image', 'Screenshot_报错信息.png', 820_000, 210), ['技术'], 4 * HOUR),
    file('白板讨论', attachment('image', '白板讨论.heic', 3_100_000, 40), ['会议'], 25 * HOUR),
    file('猫猫', attachment('image', '猫猫.jpg', 2_600_000, 25, 'uploading'), ['生活'], 15 * MIN),
    file('合同扫描件', attachment('file', '合同扫描件.pdf', 1_800_000, 0), ['合同'], 2 * DAY),
    file('周末徒步视频', attachment('video', '周末徒步.mp4', 186_000_000, 120, 'pending'), ['徒步'], 6 * HOUR),
    file('季度报告草稿', attachment('file', '季度报告-草稿.docx', 540_000, 220), ['工作'], 30 * HOUR),
    file('设计稿导出', attachment('file', '设计稿导出.zip', 32_000_000, 280, 'failed'), ['设计'], 3 * DAY),

    // 处理中（归类失败）
    item('inbox', {
      text: '（语音消息 0:42）',
      title: '语音：下周出差安排',
      attachments: [{ ...attachment('audio', 'voice_1023.silk', 96_000, 300), durationSec: 42 }],
      processing: { stage: 'failed', error: 'AI 接口超时，已重试 2 次' },
      createdAt: ago(40 * MIN),
    }),
  ]
}

export function seedSecrets(): { secret: Secret; value: string }[] {
  // 演示值故意不符合任何真实密钥格式，避免被密钥扫描误报
  const entries: [string, string, number][] = [
    ['OpenAI 兼容接口 Key', 'demo-ai-key-not-real', 2 * HOUR],
    ['夸克 Cookie', 'demo-quark-cookie-not-real', DAY],
    ['R2 备份凭据', 'demo-r2-access-key / demo-r2-secret', 2 * DAY],
    ['QQ 机器人 AppSecret', 'demo-qq-app-secret', 3 * DAY],
    ['路由器管理密码', 'Demo-Router-2026!', 5 * DAY],
    ['GitHub Token', 'demo-github-token-not-real', 7 * DAY],
  ]
  return entries.map(([label, value, age]) => ({
    secret: { id: makeId(), code: makeCode(), label, kind: 'text', createdAt: ago(age) },
    value,
  }))
}

/** 演示用的"新消息"，按顺序循环 */
export interface IncomingTemplate {
  preview: string
  kind: 'text' | 'link' | 'image' | 'video' | 'file'
  secret?: { label: string; value: string }
  result?: Partial<Item> & { partition: ItemPartition; title: string }
}

export const INCOMING: IncomingTemplate[] = [
  {
    preview: '明天下午三点提醒我交周报',
    kind: 'text',
    result: {
      partition: 'reminder',
      title: '交周报',
      reminder: { remindAt: dayAt(1, 15), repeat: 'none', status: 'scheduled' },
    },
  },
  {
    preview: 'https://sspai.com/post/90388 这篇讲个人知识库的不错',
    kind: 'link',
    result: {
      partition: 'bookmark',
      title: '个人知识库的三种搭法',
      summary: '对比卡片盒、文件夹和标签三种组织方式的优劣。',
      tags: ['知识管理'],
      link: { url: 'https://sspai.com/post/90388', site: 'sspai.com', title: '个人知识库的三种搭法' },
    },
  },
  {
    preview: '周五前把域名续费了',
    kind: 'text',
    result: { partition: 'todo', title: '续费域名', todo: { dueAt: nextWeekday(5, 18) } },
  },
  {
    preview: '#key 测试环境数据库密码',
    kind: 'text',
    secret: { label: '测试环境数据库密码', value: 'demo-Db-Pass-0482!' },
  },
  {
    preview: '[图片] Screenshot_20261023.png',
    kind: 'image',
    result: {
      partition: 'file',
      title: '订单页面截图',
      tags: ['截图'],
      attachments: [attachment('image', 'Screenshot_20261023.png', 640_000, 190, 'uploading')],
    },
  },
  {
    preview: '想到一个点子：把每天的收件数量做成热力图，像 GitHub 那样',
    kind: 'text',
    result: { partition: 'note', title: '收件热力图', tags: ['产品', '想法'] },
  },
  {
    preview: '每天晚上 11 点提醒我睡觉',
    kind: 'text',
    result: {
      partition: 'reminder',
      title: '该睡觉了',
      reminder: { remindAt: nextAt(23), repeat: 'daily', status: 'scheduled' },
    },
  },
  {
    preview: 'https://github.com/FiloSottile/age',
    kind: 'link',
    result: {
      partition: 'bookmark',
      title: 'age：简单、现代的文件加密工具',
      summary: '小巧的文件加密工具，适合给备份包加密。',
      tags: ['开源', '安全'],
      link: { url: 'https://github.com/FiloSottile/age', site: 'github.com', title: 'age：简单、现代的文件加密工具' },
    },
  },
  {
    preview: '[文件] 租房合同-2026.pdf',
    kind: 'file',
    result: {
      partition: 'file',
      title: '租房合同 2026',
      tags: ['合同'],
      attachments: [attachment('file', '租房合同-2026.pdf', 2_400_000, 0, 'uploading')],
    },
  },
  {
    preview: '买牛奶和鸡蛋',
    kind: 'text',
    result: { partition: 'todo', title: '买牛奶和鸡蛋', todo: {} },
  },
]
