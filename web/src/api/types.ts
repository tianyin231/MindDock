/** 七个分区。secret 只存在于密钥库，不会出现在普通条目里。 */
export type PartitionKey = 'inbox' | 'note' | 'bookmark' | 'todo' | 'reminder' | 'secret' | 'file'
export type ItemPartition = Exclude<PartitionKey, 'secret'>
export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly'

export interface Attachment {
  id: string
  kind: 'image' | 'video' | 'audio' | 'file'
  name: string
  size: number
  mime: string
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed'
  /** 缩略图占位色调 */
  hue: number
  durationSec?: number | null
  /** 图片已下载到服务器时的预览地址 */
  previewUrl?: string | null
  /** 原件下载地址：本地还在就直接下载，否则经 OpenList 从夸克取回 */
  downloadUrl?: string | null
  /** 原件是否还在服务器本地（上传后保留几天） */
  local?: boolean
  /** 上传失败的原因 */
  uploadError?: string | null
}

export interface LinkInfo {
  url: string
  site: string
  title: string
}

export interface TodoInfo {
  dueAt?: string
  doneAt?: string
}

export interface ReminderInfo {
  /** 下一次提醒时间；已送达的单次提醒为原定时间 */
  remindAt: string
  repeat: RepeatRule
  status: 'scheduled' | 'sent' | 'done' | 'failed' | 'cancelled'
  /** 最近一次送达的渠道与时间 */
  channel?: 'qq' | 'email' | null
  sentAt?: string | null
  doneAt?: string | null
  /** 最近一次发送失败的原因（会自动重试） */
  lastError?: string | null
}

export type ReminderAction =
  | { action: 'done' | 'cancel' }
  | { action: 'snooze'; minutes: number }
  | { action: 'reschedule'; remind_at: string; repeat: RepeatRule }

export interface Item {
  id: string
  code: string
  source: 'qq' | 'panel'
  partition: ItemPartition
  partitionSource: 'auto' | 'user'
  text: string
  title: string
  summary?: string
  tags: string[]
  createdAt: string
  link?: LinkInfo
  attachments: Attachment[]
  todo?: TodoInfo
  reminder?: ReminderInfo
  /** 仍在"处理中"时的状态 */
  processing?: { stage: 'organizing' | 'failed'; error?: string }
  ai?: { model: string; at: string }
}

export interface Secret {
  id: string
  code: string
  /** 名称是明文，内容才加密 */
  label: string
  kind: 'text' | 'file'
  createdAt: string
  /** 明文大小（字节） */
  size?: number | null
  originalName?: string | null
  mime?: string | null
  source?: 'qq' | 'panel'
  /** 自动识别的原因；显式 #key 为空 */
  detected?: string | null
  /** 文本密钥的密文（Base64 sealed box），解锁后在浏览器里打开 */
  sealed?: string | null
}

export interface VaultState {
  initialized: boolean
  publicKey: string | null
}

export interface WrapData {
  wrapped: string
  salt: string
  params: { alg: 'argon2id13'; ops: number; mem: number }
}

export interface VaultKeysData {
  publicKey: string
  password: WrapData
  recovery: WrapData
}

export interface VaultSetupBody {
  public_key: string
  password: WrapData
  recovery: WrapData
}

export interface VaultRewrapBody {
  token: string
  answer: string
  password: WrapData
  recovery?: WrapData
}

export type Counts = Record<PartitionKey, number>

export type LiveEvent =
  | { type: 'item.received'; item: Item }
  | { type: 'item.classified'; item: Item }
  | { type: 'item.updated'; item: Item }
  | { type: 'secret.stored'; secret: Secret }
  | { type: 'qq.bound' }

/** 收件台的一条：普通条目或密钥（密钥只有名称等明文信息） */
export type TimelineEntry = { kind: 'item'; item: Item } | { kind: 'secret'; secret: Secret }

export interface TimelinePage {
  entries: TimelineEntry[]
  /** 下一页游标，没有更多时为 null */
  next: string | null
}
