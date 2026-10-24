import { CalendarIcon, ExternalLinkIcon, Loader2Icon, RotateCwIcon, SparklesIcon, TriangleAlertIcon } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { useItem, useMoveItem, useRetryItem, useToggleTodo } from '@/api/hooks'
import type { Item, ItemPartition } from '@/api/types'
import { PartitionBadge, TagList } from '@/components/common'
import { AttachmentRow } from '@/components/items'
import { ReminderControls } from '@/components/ReminderControls'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { dueLabel, hm, monthDay, relativeTime } from '@/lib/format'
import { ITEM_PARAM } from '@/lib/open-item'
import { MOVABLE_PARTITIONS, PARTITION } from '@/lib/partitions'

export function ItemSheet() {
  const [params, setParams] = useSearchParams()
  const id = params.get(ITEM_PARAM)
  const { data: item, isLoading } = useItem(id)

  const close = () =>
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete(ITEM_PARAM)
      return next
    })

  return (
    <Sheet open={Boolean(id)} onOpenChange={(open) => !open && close()}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {isLoading || !item ? (
          <div className="space-y-3 p-6">
            <SheetTitle className="sr-only">加载中</SheetTitle>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-7 w-3/4" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <ItemDetail item={item} />
        )}
      </SheetContent>
    </Sheet>
  )
}

function ItemDetail({ item }: { item: Item }) {
  const move = useMoveItem()
  const retry = useRetryItem()
  const toggle = useToggleTodo()

  const onMove = (partition: ItemPartition) =>
    move.mutate(
      { id: item.id, partition },
      { onSuccess: () => toast.success(`已移到「${PARTITION[partition].label}」`) },
    )

  return (
    <>
      <SheetHeader className="gap-2 border-b pr-12">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <PartitionBadge partition={item.partition} />
          <span className="font-mono">#{item.code}</span>
          <span>· 来自{item.source === 'qq' ? ' QQ' : '面板'}</span>
          {item.partitionSource === 'user' && <span>· 手动归类</span>}
        </div>
        <SheetTitle className="text-lg leading-snug">{item.title}</SheetTitle>
        <SheetDescription>
          {relativeTime(item.createdAt)} · {monthDay(item.createdAt)} {hm(item.createdAt)}
        </SheetDescription>
      </SheetHeader>

      <div className="space-y-6 p-4">
        {item.processing && (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            {item.processing.stage === 'failed' ? (
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" />
            ) : (
              <Loader2Icon className="mt-0.5 size-4 shrink-0 animate-spin text-amber-600" />
            )}
            <div className="flex-1">
              <p className="font-medium">{item.processing.stage === 'failed' ? '归类失败' : 'AI 正在归类'}</p>
              {item.processing.error && <p className="text-xs text-muted-foreground">{item.processing.error}</p>}
            </div>
            {item.processing.stage === 'failed' && (
              <Button size="sm" variant="outline" onClick={() => retry.mutate(item.id)} disabled={retry.isPending}>
                <RotateCwIcon />
                重试
              </Button>
            )}
          </div>
        )}

        {item.todo && (
          <Field label="待办">
            <label className="flex items-center gap-3 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={Boolean(item.todo.doneAt)}
                onCheckedChange={(v) => toggle.mutate({ id: item.id, done: v === true })}
              />
              <span className="flex-1">{item.todo.doneAt ? '已完成' : '未完成'}</span>
              {item.todo.dueAt && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarIcon className="size-3.5" />
                  截止 {dueLabel(item.todo.dueAt).label}
                </span>
              )}
            </label>
          </Field>
        )}

        {(item.reminder || item.partition === 'reminder') && (
          <Field label="提醒">
            <ReminderControls key={item.id} item={item} />
          </Field>
        )}

        <Field label="原始消息">
          <p className="rounded-lg bg-muted/60 p-3 text-sm leading-relaxed break-words whitespace-pre-wrap">
            {item.text || '（无文字，仅附件）'}
          </p>
        </Field>

        {item.link && (
          <Field label="网页">
            <a
              href={item.link.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.link.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.link.url}</span>
              </span>
              <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" />
            </a>
          </Field>
        )}

        {item.attachments.length > 0 && (
          <Field label="附件">
            <div className="rounded-lg border p-1">
              {item.attachments.map((att) => (
                <AttachmentRow key={att.id} att={att} />
              ))}
            </div>
          </Field>
        )}

        {item.ai && (
          <Field label="AI 整理">
            <div className="space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3 text-sm">
              <p className="flex items-center gap-1.5 text-xs font-medium text-violet-700 dark:text-violet-400">
                <SparklesIcon className="size-3.5" />
                自动生成，不会改动原始消息
              </p>
              {item.summary && <p className="leading-relaxed">{item.summary}</p>}
              <TagList tags={item.tags} />
              <p className="text-[11px] text-muted-foreground">
                {item.ai.model} · {relativeTime(item.ai.at)}
              </p>
            </div>
          </Field>
        )}

        <Field label="移动到">
          <Select value={item.partition === 'inbox' ? undefined : item.partition} onValueChange={onMove}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择分区" />
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
        </Field>
      </div>
    </>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  )
}
