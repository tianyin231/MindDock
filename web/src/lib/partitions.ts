import {
  AlarmClockIcon,
  BookmarkIcon,
  FolderOpenIcon,
  InboxIcon,
  KeyRoundIcon,
  ListTodoIcon,
  NotebookPenIcon,
  type LucideIcon,
} from 'lucide-react'
import type { ItemPartition, PartitionKey } from '@/api/types'

export interface PartitionMeta {
  key: PartitionKey
  label: string
  path: string
  icon: LucideIcon
  description: string
  // 以下为 Tailwind 类名，必须写成完整字面量，构建时才能被扫描到
  text: string
  soft: string
  solid: string
  glow: string
  border: string
}

export const PARTITIONS: PartitionMeta[] = [
  {
    key: 'inbox',
    label: '处理中',
    path: '/inbox',
    icon: InboxIcon,
    description: '刚收到、等待 AI 归类或归类失败的消息',
    text: 'text-slate-600 dark:text-slate-300',
    soft: 'bg-slate-500/10 dark:bg-slate-400/15',
    solid: 'bg-slate-500',
    glow: 'from-slate-500/12',
    border: 'border-slate-500/30',
  },
  {
    key: 'note',
    label: '笔记',
    path: '/notes',
    icon: NotebookPenIcon,
    description: '想法、灵感与随手记',
    text: 'text-amber-600 dark:text-amber-400',
    soft: 'bg-amber-500/10 dark:bg-amber-400/15',
    solid: 'bg-amber-500',
    glow: 'from-amber-500/12',
    border: 'border-amber-500/30',
  },
  {
    key: 'bookmark',
    label: '收藏',
    path: '/bookmarks',
    icon: BookmarkIcon,
    description: '网址、文章与值得留存的内容',
    text: 'text-violet-600 dark:text-violet-400',
    soft: 'bg-violet-500/10 dark:bg-violet-400/15',
    solid: 'bg-violet-500',
    glow: 'from-violet-500/12',
    border: 'border-violet-500/30',
  },
  {
    key: 'todo',
    label: '待办',
    path: '/todos',
    icon: ListTodoIcon,
    description: '需要去做的事',
    text: 'text-emerald-600 dark:text-emerald-400',
    soft: 'bg-emerald-500/10 dark:bg-emerald-400/15',
    solid: 'bg-emerald-500',
    glow: 'from-emerald-500/12',
    border: 'border-emerald-500/30',
  },
  {
    key: 'reminder',
    label: '提醒',
    path: '/reminders',
    icon: AlarmClockIcon,
    description: '到点通过 QQ 提醒你',
    text: 'text-rose-600 dark:text-rose-400',
    soft: 'bg-rose-500/10 dark:bg-rose-400/15',
    solid: 'bg-rose-500',
    glow: 'from-rose-500/12',
    border: 'border-rose-500/30',
  },
  {
    key: 'secret',
    label: '密钥',
    path: '/secrets',
    icon: KeyRoundIcon,
    description: '加密保存，二级密码解锁后才能查看',
    text: 'text-indigo-600 dark:text-indigo-400',
    soft: 'bg-indigo-500/10 dark:bg-indigo-400/15',
    solid: 'bg-indigo-500',
    glow: 'from-indigo-500/12',
    border: 'border-indigo-500/30',
  },
  {
    key: 'file',
    label: '文件',
    path: '/files',
    icon: FolderOpenIcon,
    description: '图片、视频与文档，原件存于夸克',
    text: 'text-sky-600 dark:text-sky-400',
    soft: 'bg-sky-500/10 dark:bg-sky-400/15',
    solid: 'bg-sky-500',
    glow: 'from-sky-500/12',
    border: 'border-sky-500/30',
  },
]

export const PARTITION = Object.fromEntries(PARTITIONS.map((p) => [p.key, p])) as Record<
  PartitionKey,
  PartitionMeta
>

/** 可以手动移入的分区（处理中与密钥除外） */
export const MOVABLE_PARTITIONS = PARTITIONS.filter(
  (p): p is PartitionMeta & { key: ItemPartition } => p.key !== 'inbox' && p.key !== 'secret',
)

/** 分区主色的 CSS 变量，用于光晕、轨迹等需要动态取色的地方 */
export const partitionTone = (key: PartitionKey) => `var(--p-${key})`
