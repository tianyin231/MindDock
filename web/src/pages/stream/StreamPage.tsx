import { ArrowUpIcon, InboxIcon, LayersIcon, Loader2Icon, PauseIcon, PlayIcon, SendIcon, SparklesIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { toast } from 'sonner'
import { isDemo } from '@/api/client'
import { useAddText, useCounts, useItems, useTimeline } from '@/api/hooks'
import { entryId } from '@/api/timeline-cache'
import type { PartitionKey, TimelineEntry } from '@/api/types'
import { AnimatedCount } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LandingPulse } from '@/live/LandingPulse'
import { ORIGIN, useFlightSource, useFlightTarget, useLive } from '@/live/live'
import { dayDiff, dayLabel } from '@/lib/format'
import { MOVABLE_PARTITIONS, PARTITIONS, partitionTone, type PartitionMeta } from '@/lib/partitions'
import { cn } from '@/lib/utils'
import { StreamRow } from './StreamCard'
import { createdAtOf, partitionOf, StreamContext, useStream, type StreamState } from './stream-context'

type Filter = PartitionKey | 'all'

export function StreamPage() {
  const timeline = useTimeline()
  const [filter, setFilter] = useState<Filter>('all')
  const [hover, setHover] = useState<PartitionKey | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [drop, setDrop] = useState<PartitionKey | null>(null)

  const entries = useMemo(() => timeline.data?.pages.flatMap((p) => p.entries) ?? [], [timeline.data])

  const stream = useMemo<StreamState>(
    () => ({ hover: dragging ? null : hover, dragging, drop, setDragging, setDrop }),
    [drop, dragging, hover],
  )

  return (
    <StreamContext value={stream}>
      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_16rem] xl:gap-10">
        <div className="min-w-0">
          <StreamHeader entries={entries} />
          <Composer />
          <FilterBar filter={filter} onFilter={setFilter} />
          <Timeline
            entries={entries}
            filter={filter}
            loading={timeline.isLoading}
            hasMore={Boolean(timeline.hasNextPage)}
            loadingMore={timeline.isFetchingNextPage}
            loadMore={() => timeline.fetchNextPage()}
          />
        </div>
        <aside className="hidden xl:block">
          <div className="sticky top-20">
            <PartitionDock filter={filter} onFilter={setFilter} onHover={setHover} />
          </div>
        </aside>
      </div>
    </StreamContext>
  )
}

// ---- 页头 ----

function StreamHeader({ entries }: { entries: TimelineEntry[] }) {
  const { auto, setAuto, simulate } = useLive()
  const inbox = useItems('inbox').data ?? []
  const originRef = useFlightSource(ORIGIN, 3)
  const today = entries.filter((e) => dayDiff(createdAtOf(e)) === 0).length
  const processing = entries.filter((e) => e.kind === 'item' && e.item.processing?.stage === 'organizing').length
  // 待处理取自"处理中"列表（落地时才刷新），刚归类的那条不会在落地前被误算进来
  const waiting = inbox.filter((i) => i.processing?.stage !== 'organizing').length

  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow flex items-center gap-2">
          <span ref={originRef} className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          实时 · QQ 与面板
        </p>
        <h1 className="mt-1.5 text-[28px] leading-tight font-semibold tracking-tight">收件台</h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          每条内容从收到、AI 识别到归入分区的过程都留在这里。点开卡片查看详情
          <span className="hidden xl:inline">，拖到右侧分区即可改归类</span>。
        </p>
      </div>
      <div className="flex items-center gap-4">
        <dl className="flex gap-5 text-right">
          <Stat label="今天" value={today} />
          <Stat label="识别中" value={processing} accent={processing > 0} />
          <Stat label="待处理" value={waiting} />
        </dl>
        {isDemo && (
          <div className="flex items-center gap-1 border-l pl-4">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => setAuto(!auto)} aria-label={auto ? '暂停自动演示' : '开始自动演示'}>
                  {auto ? <PauseIcon /> : <PlayIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{auto ? '暂停自动演示' : '开始自动演示'}</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={simulate}>
              <SendIcon />
              模拟一条
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className={cn('text-xl font-semibold tabular-nums', accent && 'text-brand')}>
        <AnimatedCount value={value} />
      </dd>
    </div>
  )
}

// ---- 输入框 ----

function Composer() {
  const [text, setText] = useState('')
  const add = useAddText()
  const ref = useRef<HTMLTextAreaElement>(null)

  // 随内容自动长高，最多约 8 行
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const value = text.trim()
    if (!value || add.isPending) return
    add.mutate(value, {
      onSuccess: (entry) => {
        setText('')
        if (entry.kind === 'secret') toast.success(`已加密存入密钥库：${entry.secret.label}`)
      },
      onError: (err) => toast.error(err instanceof Error ? err.message : '发送失败'),
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
  }

  return (
    <form
      onSubmit={submit}
      className="surface mb-6 rounded-2xl p-3 transition-shadow focus-within:shadow-[var(--surface-highlight),var(--surface-shadow-lift),0_0_0_3px_color-mix(in_oklch,var(--brand)_18%,transparent)]"
    >
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        maxLength={10000}
        placeholder="写下想法、贴一个链接，或用 #key 存一条密钥…"
        aria-label="投递到收件台"
        className="block w-full resize-none bg-transparent px-1.5 py-1 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/70"
      />
      <div className="mt-2 flex items-center gap-3">
        <span className="hidden items-center gap-3 text-[11px] text-muted-foreground sm:flex">
          <Hint code="#标签" label="打标签" />
          <Hint code="#noai" label="不交给 AI" />
          <Hint code="#key" label="存为密钥" />
        </span>
        <span className="ml-auto hidden font-mono text-[11px] text-muted-foreground/80 sm:inline">Ctrl ↵</span>
        <Button type="submit" size="sm" disabled={!text.trim() || add.isPending} className="ml-auto rounded-full px-3 sm:ml-0">
          {add.isPending ? <Loader2Icon className="animate-spin" /> : <ArrowUpIcon />}
          收进来
        </Button>
      </div>
    </form>
  )
}

function Hint({ code, label }: { code: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <code className="rounded-md border bg-muted/60 px-1 py-px font-mono text-[10.5px]">{code}</code>
      {label}
    </span>
  )
}

// ---- 分区：宽屏是右侧竖栏，窄屏是顶部横向标签；同时是筛选器、拖放目标和飞行落点 ----

function useDockCounts(): Partial<Record<Filter, number>> {
  const { data } = useCounts()
  if (!data) return {}
  return { ...data, all: Object.values(data).reduce((a, b) => a + b, 0) }
}

function PartitionDock({
  filter,
  onFilter,
  onHover,
}: {
  filter: Filter
  onFilter: (f: Filter) => void
  onHover: (p: PartitionKey | null) => void
}) {
  const counts = useDockCounts()
  const { dragging } = useStream()
  return (
    <nav aria-label="按分区筛选" className="surface rounded-2xl p-2" onMouseLeave={() => onHover(null)}>
      <p className="eyebrow px-2.5 pt-1.5 pb-2">分区</p>
      <DockRow label="全部" icon={LayersIcon} count={counts.all} active={filter === 'all'} onClick={() => onFilter('all')} />
      <div className="my-1.5 h-px bg-border" />
      {PARTITIONS.map((p) => (
        <DockPartition
          key={p.key}
          meta={p}
          count={counts[p.key]}
          active={filter === p.key}
          onClick={() => onFilter(filter === p.key ? 'all' : p.key)}
          onHover={onHover}
        />
      ))}
      <p className="px-2.5 pt-3 pb-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {dragging ? '松开即可移到高亮的分区' : '把鼠标停在分区上，时间线会突出该分区的内容'}
      </p>
    </nav>
  )
}

function DockRow({
  label,
  icon: Icon,
  count,
  active,
  onClick,
  iconClassName,
  className,
  children,
  ...rest
}: {
  label: string
  icon: PartitionMeta['icon']
  count?: number
  active: boolean
  onClick: () => void
  iconClassName?: string
  className?: string
  children?: ReactNode
} & Omit<ComponentProps<'button'>, 'onClick'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors',
        active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
      {...rest}
    >
      {active && (
        <motion.span
          layoutId="dock-active"
          className="absolute inset-0 rounded-xl bg-muted shadow-[inset_0_0_0_1px_var(--border)]"
          transition={{ type: 'spring', stiffness: 420, damping: 34 }}
        />
      )}
      {children}
      <span className={cn('relative flex size-7 items-center justify-center rounded-lg bg-muted', iconClassName)}>
        <Icon className="size-4" />
      </span>
      <span className="relative flex-1">{label}</span>
      {count !== undefined && <AnimatedCount value={count} className="relative font-mono text-xs text-muted-foreground" />}
    </button>
  )
}

function DockPartition({
  meta,
  count,
  active,
  onClick,
  onHover,
}: {
  meta: PartitionMeta
  count?: number
  active: boolean
  onClick: () => void
  onHover: (p: PartitionKey | null) => void
}) {
  const { dragging, drop } = useStream()
  const targetRef = useFlightTarget(meta.key, 3)
  const droppable = dragging !== null && MOVABLE_PARTITIONS.some((p) => p.key === meta.key)
  const over = drop === meta.key

  return (
    <DockRow
      ref={targetRef}
      label={over ? `移到「${meta.label}」` : meta.label}
      icon={meta.icon}
      count={count}
      active={active}
      onClick={onClick}
      onMouseEnter={() => onHover(meta.key)}
      onFocus={() => onHover(meta.key)}
      onBlur={() => onHover(null)}
      iconClassName={cn(meta.soft, meta.text)}
      className={cn(
        droppable && 'outline-1 -outline-offset-1 outline-border outline-dashed',
        over && 'scale-[1.03] text-foreground outline-solid',
        dragging !== null && !droppable && 'opacity-40',
      )}
      style={over ? { outlineColor: partitionTone(meta.key), background: `color-mix(in oklch, ${partitionTone(meta.key)} 10%, transparent)` } : undefined}
    >
      <LandingPulse partition={meta.key} />
    </DockRow>
  )
}

function FilterBar({ filter, onFilter }: { filter: Filter; onFilter: (f: Filter) => void }) {
  const counts = useDockCounts()
  return (
    <div className="sticky top-14 z-20 -mx-4 mb-4 border-b border-transparent bg-background/80 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 xl:hidden">
      <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
        <Chip active={filter === 'all'} onClick={() => onFilter('all')} label="全部" count={counts.all} />
        {PARTITIONS.map((p) => (
          <PartitionChip
            key={p.key}
            meta={p}
            count={counts[p.key]}
            active={filter === p.key}
            onClick={() => onFilter(filter === p.key ? 'all' : p.key)}
          />
        ))}
      </div>
    </div>
  )
}

function PartitionChip({ meta, ...rest }: { meta: PartitionMeta; count?: number; active: boolean; onClick: () => void }) {
  const targetRef = useFlightTarget(meta.key, 3)
  return (
    <Chip ref={targetRef} label={meta.label} dot={partitionTone(meta.key)} {...rest}>
      <LandingPulse partition={meta.key} />
    </Chip>
  )
}

function Chip({
  label,
  count,
  active,
  onClick,
  dot,
  children,
  ref,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
  dot?: string
  children?: ReactNode
  ref?: Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors',
        active ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {dot && <span className="size-1.5 rounded-full" style={{ background: dot }} />}
      {label}
      {count !== undefined && <span className={cn('font-mono tabular-nums', active ? 'opacity-70' : 'opacity-60')}>{count}</span>}
    </button>
  )
}

// ---- 时间线 ----

type Row = { type: 'day'; key: string; label: string; count: number } | { type: 'entry'; key: string; entry: TimelineEntry }

function Timeline({
  entries,
  filter,
  loading,
  hasMore,
  loadingMore,
  loadMore,
}: {
  entries: TimelineEntry[]
  filter: Filter
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}) {
  const { hover, dragging } = useStream()

  // 首屏已有的条目不算"新到"；之后实时进来的才有一闪而过的高亮
  const [initial, setInitial] = useState<Set<string> | null>(null)
  if (initial === null && !loading) setInitial(new Set(entries.map(entryId)))

  const shown = filter === 'all' ? entries : entries.filter((e) => partitionOf(e) === filter)
  const rows = useMemo(() => {
    const out: Row[] = []
    const days = new Map<string, Extract<Row, { type: 'day' }>>()
    for (const entry of shown) {
      const at = createdAtOf(entry)
      const key = `day-${new Date(at).toDateString()}`
      let day = days.get(key)
      if (!day) {
        day = { type: 'day', key, label: dayLabel(at), count: 0 }
        days.set(key, day)
        out.push(day)
      }
      day.count++
      out.push({ type: 'entry', key: entryId(entry), entry })
    }
    return out
  }, [shown])

  // 滚到底部自动加载更多
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el || !hasMore) return
    const io = new IntersectionObserver(([e]) => e.isIntersecting && !loadingMore && loadMore(), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, loadMore, loadingMore])

  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[2.75rem_1rem_minmax(0,1fr)]">
            <span className="hidden sm:block" />
            <span />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        ))}
      </div>
    )
  }

  if (shown.length === 0) return <EmptyTimeline filtered={filter !== 'all'} />

  return (
    <>
      <ol aria-label="时间线">
        <AnimatePresence initial={false}>
          {rows.map((row) =>
            row.type === 'day' ? (
              <motion.li
                key={row.key}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-3 pt-3 pb-4 first:pt-0"
              >
                <span className="text-sm font-semibold">{row.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{row.count} 条</span>
                <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
              </motion.li>
            ) : (
              <StreamRow
                key={row.key}
                entry={row.entry}
                fresh={initial !== null && !initial.has(row.key)}
                dimmed={hover !== null && partitionOf(row.entry) !== hover && dragging !== row.key}
              />
            ),
          )}
        </AnimatePresence>
      </ol>
      <div ref={sentinel} className="flex justify-center py-6 text-xs text-muted-foreground">
        {loadingMore ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : hasMore ? (
          <button type="button" onClick={loadMore} className="hover:text-foreground">
            加载更早的内容
          </button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="h-px w-8 bg-border" />
            已经到底了
            <span className="h-px w-8 bg-border" />
          </span>
        )}
      </div>
    </>
  )
}

function EmptyTimeline({ filtered }: { filtered: boolean }) {
  return (
    <div className="surface flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
      <span className="relative flex size-14 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/10 [animation-duration:2.4s]" />
        <span className="relative flex size-14 items-center justify-center rounded-full bg-brand/10 text-brand">
          {filtered ? <InboxIcon className="size-6" /> : <SparklesIcon className="size-6" />}
        </span>
      </span>
      <p className="text-sm font-medium">{filtered ? '这个分区暂时没有内容' : '还没有收到任何内容'}</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {filtered
          ? '换一个分区看看，或者在上面写点什么'
          : '在 QQ 里把文字、链接、图片或文件发给 MindDock 机器人，或者直接在上面的输入框里写下来，归类过程会实时出现在这里'}
      </p>
    </div>
  )
}
