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
  /** 缩略图主色调（演示数据用） */
  hue: number
  durationSec?: number
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
  remindAt: string
  repeat: RepeatRule
  status: 'scheduled' | 'sent' | 'failed'
  channel?: 'qq' | 'email'
}

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
  label: string
  kind: 'text' | 'file'
  createdAt: string
}

export type Counts = Record<PartitionKey, number>

export type LiveEvent =
  | { type: 'item.received'; item: Item }
  | { type: 'item.classified'; item: Item }
  | { type: 'secret.stored'; secret: Secret }
