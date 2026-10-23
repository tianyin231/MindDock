import {
  BookmarkIcon,
  FolderOpenIcon,
  InboxIcon,
  Loader2Icon,
  NotebookPenIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useItems, useMoveItem, useRetryItem } from '@/api/hooks'
import type { Item, ItemPartition } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { AttachmentRow, BookmarkCard, FileTile, NoteCard } from '@/components/items'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { dayLabel, relativeTime } from '@/lib/format'
import { useOpenItem } from '@/lib/open-item'
import { MOVABLE_PARTITIONS, PARTITION } from '@/lib/partitions'
import { cn } from '@/lib/utils'

function GridSkeleton({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-36 rounded-xl" />
      ))}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs transition-colors',
        active ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

// ---- 处理中 ----

export function InboxPage() {
  const { data, isLoading } = useItems('inbox')
  const items = data ?? []
  return (
    <div className="space-y-6">
      <PageHeader partition="inbox" count={items.length} />
      {isLoading ? (
        <GridSkeleton count={2} />
      ) : items.length === 0 ? (
        <EmptyState icon={InboxIcon} title="全部已归类" hint="新消息会先出现在这里，AI 归类完成后自动移走" />
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <InboxRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

function InboxRow({ item }: { item: Item }) {
  const retry = useRetryItem()
  const move = useMoveItem()
  const openItem = useOpenItem()
  const failed = item.processing?.stage === 'failed'

  return (
    <motion.div layout className="rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            failed ? 'bg-amber-500/10 text-amber-600' : 'bg-violet-500/10 text-violet-600',
          )}
        >
          {failed ? <TriangleAlertIcon className="size-4" /> : <Loader2Icon className="size-4 animate-spin" />}
        </span>
        <button type="button" onClick={() => openItem(item.id)} className="min-w-0 flex-1 text-left">
          <p className="text-sm font-medium">{item.title}</p>
          <p className="text-xs text-muted-foreground">
            {relativeTime(item.createdAt)} · {failed ? item.processing?.error : 'AI 正在归类'}
          </p>
        </button>
        {failed && (
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => retry.mutate(item.id)} disabled={retry.isPending}>
              <RotateCwIcon />
              重试
            </Button>
            <Select
              onValueChange={(p: ItemPartition) =>
                move.mutate(
                  { id: item.id, partition: p },
                  { onSuccess: () => toast.success(`已移到「${PARTITION[p].label}」`) },
                )
              }
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue placeholder="手动归类" />
              </SelectTrigger>
              <SelectContent>
                {MOVABLE_PARTITIONS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    <p.icon className={p.text} />
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {item.attachments.length > 0 && (
        <div className="mt-3 rounded-lg border p-1">
          {item.attachments.map((a) => (
            <AttachmentRow key={a.id} att={a} onClick={() => openItem(item.id)} />
          ))}
        </div>
      )}
    </motion.div>
  )
}

// ---- 笔记 ----

export function NotesPage() {
  const { data, isLoading } = useItems('note')
  const groups = useMemo(() => {
    const map = new Map<string, Item[]>()
    for (const item of data ?? []) {
      const key = dayLabel(item.createdAt)
      map.set(key, [...(map.get(key) ?? []), item])
    }
    return [...map.entries()]
  }, [data])

  return (
    <div className="space-y-6">
      <PageHeader partition="note" count={data?.length} />
      {isLoading ? (
        <GridSkeleton />
      ) : groups.length === 0 ? (
        <EmptyState icon={NotebookPenIcon} title="还没有笔记" hint="在 QQ 里随手发一句想法，就会出现在这里" />
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="space-y-3">
            <h2 className="sticky top-14 z-10 -mx-1 bg-background/85 px-1 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
              {day}
            </h2>
            <div className="columns-1 gap-3 sm:columns-2 xl:columns-3 [&>*]:mb-3 [&>*]:break-inside-avoid">
              {items.map((item) => (
                <NoteCard key={item.id} item={item} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

// ---- 收藏 ----

export function BookmarksPage() {
  const { data, isLoading } = useItems('bookmark')
  const [tag, setTag] = useState<string | null>(null)
  const tags = useMemo(() => [...new Set((data ?? []).flatMap((i) => i.tags))], [data])
  const items = (data ?? []).filter((i) => !tag || i.tags.includes(tag))

  return (
    <div className="space-y-6">
      <PageHeader partition="bookmark" count={data?.length} />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Chip active={tag === null} onClick={() => setTag(null)}>
            全部
          </Chip>
          {tags.map((t) => (
            <Chip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              #{t}
            </Chip>
          ))}
        </div>
      )}
      {isLoading ? (
        <GridSkeleton count={8} className="xl:grid-cols-4" />
      ) : items.length === 0 ? (
        <EmptyState icon={BookmarkIcon} title="还没有收藏" hint="在 QQ 里分享一个网页链接，就会出现在这里" />
      ) : (
        <motion.div layout className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => (
            <BookmarkCard key={item.id} item={item} />
          ))}
        </motion.div>
      )}
    </div>
  )
}

// ---- 文件 ----

const FILE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'file', label: '文档' },
] as const

export function FilesPage() {
  const { data, isLoading } = useItems('file')
  const [filter, setFilter] = useState<(typeof FILE_FILTERS)[number]['key']>('all')
  const items = (data ?? []).filter((i) => filter === 'all' || i.attachments[0]?.kind === filter)
  const pending = (data ?? []).filter((i) => i.attachments.some((a) => a.uploadStatus !== 'uploaded')).length

  return (
    <div className="space-y-6">
      <PageHeader
        partition="file"
        count={data?.length}
        actions={
          pending > 0 && <span className="text-xs text-muted-foreground">{pending} 个文件等待上传到夸克</span>
        }
      />
      <div className="flex flex-wrap gap-2">
        {FILE_FILTERS.map((f) => (
          <Chip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </Chip>
        ))}
      </div>
      {isLoading ? (
        <GridSkeleton count={8} className="grid-cols-2 sm:grid-cols-3 xl:grid-cols-5" />
      ) : items.length === 0 ? (
        <EmptyState icon={FolderOpenIcon} title="没有文件" hint="在 QQ 里发送图片、视频或文档，原件会归档到夸克网盘" />
      ) : (
        <motion.div layout className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => (
            <FileTile key={item.id} item={item} />
          ))}
        </motion.div>
      )}
    </div>
  )
}
