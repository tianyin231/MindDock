import {
  AudioLinesIcon,
  BellRingIcon,
  CircleCheckIcon,
  CloudAlertIcon,
  CloudIcon,
  CloudUploadIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileIcon,
  FileTextIcon,
  FilmIcon,
  ImageIcon,
  MailIcon,
  MessageCircleIcon,
  RepeatIcon,
} from 'lucide-react'
import { motion } from 'motion/react'
import type { Attachment, Item } from '@/api/types'
import { useToggleTodo } from '@/api/hooks'
import { Checkbox } from '@/components/ui/checkbox'
import { TagList } from '@/components/common'
import { useOpenItem } from '@/lib/open-item'
import { dueLabel, duration, fileSize, hm, relativeTime, REPEAT_LABEL, shortDay } from '@/lib/format'
import { cn } from '@/lib/utils'

// ---- 附件 ----

function FileKindIcon({ att, className }: { att: Attachment; className?: string }) {
  if (att.kind === 'image') return <ImageIcon className={className} />
  if (att.kind === 'video') return <FilmIcon className={className} />
  if (att.kind === 'audio') return <AudioLinesIcon className={className} />
  if (/\.(zip|rar|7z|tar|gz)$/i.test(att.name)) return <FileArchiveIcon className={className} />
  if (/\.(pdf|docx?|txt|md)$/i.test(att.name)) return <FileTextIcon className={className} />
  return <FileIcon className={className} />
}

/** 缩略图：图片已在服务器上就直接显示，否则用色块占位 */
export function Thumb({ att, className }: { att: Attachment; className?: string }) {
  const visual = att.kind === 'image' || att.kind === 'video'
  if (att.previewUrl) {
    return (
      <div className={cn('overflow-hidden rounded-lg bg-muted', className)}>
        <img src={att.previewUrl} alt={att.name} loading="lazy" className="size-full object-cover" />
      </div>
    )
  }
  return (
    <div
      className={cn('relative flex items-center justify-center overflow-hidden rounded-lg', className)}
      style={
        visual
          ? {
              background: `linear-gradient(135deg, oklch(0.82 0.1 ${att.hue}), oklch(0.62 0.15 ${att.hue + 50}))`,
            }
          : undefined
      }
    >
      {visual ? (
        <>
          <svg viewBox="0 0 100 60" className="absolute inset-x-0 bottom-0 w-full opacity-35" aria-hidden="true">
            <path d="M0 60 L28 28 L46 44 L70 18 L100 50 L100 60 Z" fill="white" />
          </svg>
          {att.kind === 'video' && (
            <span className="relative flex size-8 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur">
              <FilmIcon className="size-4" />
            </span>
          )}
        </>
      ) : (
        <span className="flex size-full items-center justify-center bg-muted text-muted-foreground">
          <FileKindIcon att={att} className="size-5" />
        </span>
      )}
    </div>
  )
}

export function UploadStatus({ status }: { status: Attachment['uploadStatus'] }) {
  const map = {
    uploaded: { icon: CloudIcon, label: '已存夸克', cls: 'text-emerald-600 dark:text-emerald-400' },
    uploading: { icon: CloudUploadIcon, label: '上传中', cls: 'text-sky-600 dark:text-sky-400 animate-pulse' },
    pending: { icon: CloudUploadIcon, label: '待上传', cls: 'text-muted-foreground' },
    failed: { icon: CloudAlertIcon, label: '上传失败', cls: 'text-destructive' },
  }[status]
  const Icon = map.icon
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', map.cls)}>
      <Icon className="size-3.5" />
      {map.label}
    </span>
  )
}

export function AttachmentRow({ att, onClick }: { att: Attachment; onClick?: () => void }) {
  const body = (
    <>
      <Thumb att={att} className="size-10 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{att.name}</span>
        <span className="text-xs text-muted-foreground">
          {att.size ? fileSize(att.size) : '下载中…'}
          {att.durationSec != null && ` · ${duration(att.durationSec)}`}
        </span>
      </span>
      {att.downloadUrl && !onClick ? (
        <DownloadIcon className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <UploadStatus status={att.uploadStatus} />
      )}
    </>
  )
  const cls = 'flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-muted/60'
  // 详情里可直接下载原件；列表里点击打开详情
  if (att.downloadUrl && !onClick) {
    return (
      <a href={att.downloadUrl} className={cls} title="下载原件">
        {body}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {body}
    </button>
  )
}

// ---- 待办 ----

const DUE_TONE = {
  overdue: 'bg-destructive/10 text-destructive',
  today: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  soon: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  later: 'bg-muted text-muted-foreground',
}

export function TodoRow({ item, className }: { item: Item; className?: string }) {
  const toggle = useToggleTodo()
  const openItem = useOpenItem()
  const done = Boolean(item.todo?.doneAt)
  const due = item.todo?.dueAt ? dueLabel(item.todo.dueAt) : null

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className={cn('group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50', className)}
    >
      <Checkbox
        checked={done}
        onCheckedChange={(v) => toggle.mutate({ id: item.id, done: v === true })}
        aria-label={done ? '标记为未完成' : '标记为完成'}
        className="size-[18px] rounded-full data-checked:border-emerald-500 data-checked:bg-emerald-500"
      />
      <button type="button" onClick={() => openItem(item.id)} className="min-w-0 flex-1 text-left">
        <span
          className={cn(
            'relative block truncate text-sm transition-colors',
            done && 'text-muted-foreground line-through decoration-muted-foreground/60',
          )}
        >
          {item.title}
        </span>
      </button>
      {due && !done && (
        <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium', DUE_TONE[due.tone])}>
          {due.label}
        </span>
      )}
      {done && item.todo?.doneAt && (
        <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.todo.doneAt)}完成</span>
      )}
    </motion.div>
  )
}

// ---- 提醒 ----

export function ReminderRow({ item, className }: { item: Item; className?: string }) {
  const openItem = useOpenItem()
  const r = item.reminder!
  const sent = r.status === 'sent'
  return (
    <motion.button
      layout
      type="button"
      onClick={() => openItem(item.id)}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/50',
        sent && 'opacity-60',
        className,
      )}
    >
      <span className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-rose-500/10 py-1 text-rose-700 dark:text-rose-400">
        <span className="text-sm font-semibold tabular-nums">{hm(r.remindAt)}</span>
        <span className="text-[10px] leading-tight">{shortDay(r.remindAt)}</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {r.repeat !== 'none' && (
            <span className="inline-flex items-center gap-1">
              <RepeatIcon className="size-3" />
              {REPEAT_LABEL[r.repeat]}
            </span>
          )}
          {sent ? (
            <span className="inline-flex items-center gap-1">
              {r.channel === 'email' ? <MailIcon className="size-3" /> : <MessageCircleIcon className="size-3" />}
              已通过{r.channel === 'email' ? '邮件' : ' QQ '}送达
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <BellRingIcon className="size-3" />
              到点 QQ 提醒
            </span>
          )}
        </span>
      </span>
      {sent && <CircleCheckIcon className="size-4 shrink-0 text-emerald-500" />}
    </motion.button>
  )
}

// ---- 收藏 ----

export function BookmarkCard({ item }: { item: Item }) {
  const openItem = useOpenItem()
  const site = item.link?.site ?? ''
  const hue = [...site].reduce((h, ch) => (h + ch.charCodeAt(0) * 7) % 360, 0)
  return (
    <motion.button
      layout
      type="button"
      onClick={() => openItem(item.id)}
      whileHover={{ y: -2 }}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card text-left shadow-xs transition-shadow hover:shadow-md"
    >
      <div
        className="relative flex h-20 items-end p-3"
        style={{ background: `linear-gradient(135deg, oklch(0.9 0.05 ${hue}), oklch(0.75 0.11 ${hue + 40}))` }}
      >
        <span aria-hidden="true" className="absolute inset-0 hidden bg-black/45 dark:block" />
        <span className="relative flex size-8 items-center justify-center rounded-lg bg-white/85 text-sm font-bold text-zinc-800 shadow-sm">
          {site.charAt(0).toUpperCase()}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <span className="text-xs text-muted-foreground">{site}</span>
        <span className="line-clamp-2 text-sm leading-snug font-medium">{item.title}</span>
        {item.summary && <span className="line-clamp-2 text-xs text-muted-foreground">{item.summary}</span>}
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <TagList tags={item.tags} />
          <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
        </div>
      </div>
    </motion.button>
  )
}

// ---- 笔记 ----

export function NoteCard({ item, className }: { item: Item; className?: string }) {
  const openItem = useOpenItem()
  return (
    <motion.button
      layout
      type="button"
      onClick={() => openItem(item.id)}
      className={cn(
        'flex w-full flex-col gap-2 rounded-xl border bg-card p-4 text-left shadow-xs transition-shadow hover:shadow-md',
        className,
      )}
    >
      <span className="text-sm font-medium">{item.title}</span>
      <span className="line-clamp-4 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
        {item.text}
      </span>
      <div className="flex items-center justify-between gap-2">
        <TagList tags={item.tags} />
        <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(item.createdAt)}</span>
      </div>
    </motion.button>
  )
}

// ---- 文件 ----

export function FileTile({ item }: { item: Item }) {
  const openItem = useOpenItem()
  const att = item.attachments[0]
  if (!att) return null
  const visual = att.kind === 'image' || att.kind === 'video'
  return (
    <motion.button
      layout
      type="button"
      onClick={() => openItem(item.id)}
      whileHover={{ scale: 1.02 }}
      className="group relative aspect-square overflow-hidden rounded-xl border bg-card text-left"
    >
      {visual ? (
        <>
          <Thumb att={att} className="size-full rounded-none" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 to-transparent p-2.5 pt-8 text-white">
            <span className="block truncate text-xs font-medium">{item.title}</span>
            <span className="text-[10px] opacity-80">{fileSize(att.size)}</span>
          </div>
        </>
      ) : (
        <div className="flex size-full flex-col justify-between p-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <FileKindIcon att={att} className="size-5" />
          </span>
          <span>
            <span className="line-clamp-2 text-xs font-medium">{att.name}</span>
            <span className="text-[10px] text-muted-foreground">{fileSize(att.size)}</span>
          </span>
        </div>
      )}
      {att.uploadStatus !== 'uploaded' && (
        <span className="absolute top-2 right-2 rounded-full bg-background/90 px-1.5 py-0.5 shadow-sm">
          <UploadStatus status={att.uploadStatus} />
        </span>
      )}
    </motion.button>
  )
}
