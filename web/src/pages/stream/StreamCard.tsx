import {
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  LockIcon,
  MessageCircleIcon,
  PenLineIcon,
  RotateCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { AnimatePresence, motion, useDragControls } from 'motion/react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { useMoveItem, useRetryItem, useToggleTodo } from '@/api/hooks'
import type { Item, ItemPartition, PartitionKey, Secret, TimelineEntry } from '@/api/types'
import { TagList } from '@/components/common'
import { AttachmentRow, Thumb } from '@/components/items'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useFlightSource, useLive } from '@/live/live'
import { dayLabel, hm, REPEAT_LABEL } from '@/lib/format'
import { useOpenItem } from '@/lib/open-item'
import { MOVABLE_PARTITIONS, PARTITION, partitionTone } from '@/lib/partitions'
import { reminderStatus } from '@/lib/reminder-status'
import { useChangeCount } from '@/lib/use-change-count'
import { cn } from '@/lib/utils'
import { createdAtOf, partitionOf, useStream } from './stream-context'

type CardState = 'processing' | 'failed' | 'waiting' | 'sorted'

function itemState(item: Item): CardState {
  if (item.partition !== 'inbox') return 'sorted'
  if (item.processing?.stage === 'organizing') return 'processing'
  if (item.processing?.stage === 'failed') return 'failed'
  return 'waiting'
}

const MOVABLE = new Set<PartitionKey>(MOVABLE_PARTITIONS.map((p) => p.key))
const SPRING = { type: 'spring', stiffness: 260, damping: 30 } as const

/** 时间线上的一行：左侧时间与轨道节点，右侧卡片 */
export function StreamRow({ entry, fresh, dimmed }: { entry: TimelineEntry; fresh: boolean; dimmed: boolean }) {
  const at = createdAtOf(entry)
  const state = entry.kind === 'item' ? itemState(entry.item) : 'sorted'
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -18, filter: 'blur(6px)' }}
      animate={{ opacity: dimmed ? 0.32 : 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.18 } }}
      // 上方卡片变高时紧跟着让位，避免短暂重叠
      transition={{ ...SPRING, layout: { type: 'spring', stiffness: 560, damping: 44 } }}
      className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 pb-3 sm:grid-cols-[2.75rem_1rem_minmax(0,1fr)]"
    >
      <time dateTime={at} className="hidden pt-[15px] text-right font-mono text-[11px] text-muted-foreground tabular-nums sm:block">
        {hm(at)}
      </time>
      <RailNode partition={partitionOf(entry)} state={state} />
      {entry.kind === 'item' ? <ItemCard item={entry.item} fresh={fresh} /> : <SecretCard secret={entry.secret} fresh={fresh} />}
    </motion.li>
  )
}

function RailNode({ partition, state }: { partition: PartitionKey; state: CardState }) {
  const stamp = useChangeCount(partition)
  const color =
    state === 'processing' ? 'var(--brand)' : state === 'failed' ? 'var(--color-amber-500)' : partitionTone(partition)
  return (
    <div className="relative flex justify-center before:absolute before:top-0 before:-bottom-3 before:w-px before:bg-border">
      <span className="relative mt-[18px] flex size-2.5">
        {state === 'processing' && (
          <span className="absolute inset-0 animate-ping rounded-full opacity-60" style={{ background: color }} />
        )}
        {stamp > 0 && (
          <motion.span
            key={stamp}
            className="absolute inset-0 rounded-full"
            style={{ background: color }}
            initial={{ scale: 1, opacity: 0.7 }}
            animate={{ scale: 3.2, opacity: 0 }}
            transition={{ duration: 0.9, ease: 'easeOut' }}
          />
        )}
        <span
          className="relative size-2.5 rounded-full shadow-[0_0_0_4px_var(--background)] transition-colors duration-500"
          style={{ background: color }}
        />
      </span>
    </div>
  )
}

/** 分区印章：分区变化时像盖章一样落下，同时作为飞行动画的起点 */
function PartitionStamp({ partition, sourceKey }: { partition: PartitionKey; sourceKey: string }) {
  const meta = PARTITION[partition]
  const Icon = meta.icon
  const stamp = useChangeCount(partition)
  const sourceRef = useFlightSource(sourceKey, 3)
  return (
    <motion.span
      ref={sourceRef}
      key={stamp}
      initial={stamp > 0 ? { scale: 1.7, opacity: 0, rotate: -12 } : false}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 520, damping: 22 }}
      className={cn('inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium', meta.soft, meta.text)}
    >
      <Icon className="size-3.5" />
      {meta.label}
    </motion.span>
  )
}

function StatusChip({ item, state }: { item: Item; state: CardState }) {
  if (state === 'processing') {
    return (
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-brand/10 px-2 text-xs font-medium">
        <SparklesIcon className="size-3.5 text-brand" />
        <span className="shimmer-text">AI 正在识别</span>
      </span>
    )
  }
  if (state === 'failed' || state === 'waiting') {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-full bg-amber-500/12 px-2 text-xs font-medium text-amber-700 dark:text-amber-400">
        <TriangleAlertIcon className="size-3.5" />
        待处理
      </span>
    )
  }
  return <PartitionStamp partition={item.partition} sourceKey={item.id} />
}

// ---- 卡片外壳 ----

function CardShell({
  state,
  fresh,
  open,
  children,
  className,
}: {
  state: CardState
  fresh: boolean
  open: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'surface relative rounded-2xl transition-shadow duration-300 hover:surface-lift',
        state === 'processing' && 'beam',
        open && 'surface-lift',
        className,
      )}
    >
      {fresh && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[inherit]"
          style={{
            background: 'radial-gradient(120% 90% at 0% 0%, color-mix(in oklch, var(--brand) 16%, transparent), transparent 65%)',
          }}
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 2.4, delay: 1.2 }}
        />
      )}
      {children}
    </div>
  )
}

function SourceMeta({ source, code, at }: { source?: 'qq' | 'panel'; code: string; at: string }) {
  const Icon = source === 'panel' ? PenLineIcon : MessageCircleIcon
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" />
      <span>{source === 'panel' ? '面板' : 'QQ'}</span>
      <span className="text-border">/</span>
      <span className="font-mono text-[11px] tracking-wide">#{code}</span>
      <span className="font-mono text-[11px] tabular-nums sm:hidden">· {hm(at)}</span>
    </span>
  )
}

// ---- 处理轨迹：收到 → 识别 → 归入，留在卡片上不消失 ----

type StepStatus = 'done' | 'active' | 'error' | 'skip' | 'pending'

function Journey({ steps }: { steps: { label: string; status: StepStatus; color?: string }[] }) {
  return (
    <ol className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true" className="h-px w-3 bg-border sm:w-5" />}
          <span className={cn('flex items-center gap-1.5', s.status === 'error' && 'text-amber-700 dark:text-amber-400')}>
            <StepDot status={s.status} color={s.color} />
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function StepDot({ status, color }: { status: StepStatus; color?: string }) {
  if (status === 'done') {
    return (
      <span
        className="flex size-3.5 items-center justify-center rounded-full text-white"
        style={{ background: color ?? 'var(--muted-foreground)' }}
      >
        <CheckIcon className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span className="relative flex size-3.5 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/40" />
        <span className="size-2 rounded-full bg-brand" />
      </span>
    )
  }
  if (status === 'error') return <span className="size-2 rounded-full bg-amber-500" />
  return <span className={cn('size-2 rounded-full border border-muted-foreground/50', status === 'skip' && 'bg-muted')} />
}

function itemJourney(item: Item, state: CardState) {
  const ai: { label: string; status: StepStatus } =
    state === 'processing'
      ? { label: 'AI 识别中', status: 'active' }
      : state === 'failed'
        ? { label: item.processing?.error?.includes('#noai') ? '按要求不交给 AI' : '识别没有完成', status: 'error' }
        : item.ai
          ? { label: 'AI 已识别', status: 'done' }
          : { label: '未经 AI', status: 'skip' }
  const meta = PARTITION[item.partition]
  const last: { label: string; status: StepStatus; color?: string } =
    state === 'sorted'
      ? {
          label: `${item.partitionSource === 'user' ? '手动归入' : '归入'}「${meta.label}」`,
          status: 'done',
          color: partitionTone(item.partition),
        }
      : { label: '等待归类', status: 'pending' }
  return [{ label: `收到 ${hm(item.createdAt)}`, status: 'done' as const }, ai, last]
}

// ---- 普通条目 ----

function ItemCard({ item, fresh }: { item: Item; fresh: boolean }) {
  const [open, setOpen] = useState(false)
  const state = itemState(item)
  const stream = useStream()
  const { fly, targetAt } = useLive()
  const move = useMoveItem()
  const controls = useDragControls()
  const cardRef = useRef<HTMLDivElement>(null)
  const dropRef = useRef<PartitionKey | null>(null)
  const canMove = state !== 'processing'

  const moveTo = useCallback(
    (partition: ItemPartition) => {
      if (partition === item.partition) return
      move.mutate(
        { id: item.id, partition },
        {
          onSuccess: () => {
            const chip = cardRef.current?.querySelector<HTMLElement>('[data-stamp]')
            if (chip) fly(chip, partition, item.title)
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : '移动失败'),
        },
      )
    },
    [fly, item.id, item.partition, item.title, move],
  )

  return (
    <motion.div
      ref={cardRef}
      drag={canMove}
      dragControls={controls}
      dragListener={false}
      dragSnapToOrigin
      dragTransition={{ bounceStiffness: 400, bounceDamping: 32 }}
      // 拖动时以把手所在的左上角为原点缩小，指针始终捏着把手，也不会挡住目标分区
      style={{ originX: 0, originY: 0 }}
      whileDrag={{ scale: 0.6, rotate: -2, zIndex: 40, cursor: 'grabbing' }}
      onDragStart={() => stream.setDragging(item.id)}
      onDrag={(event) => {
        const { clientX, clientY } = event as PointerEvent
        const target = targetAt(clientX, clientY)
        const next = target && MOVABLE.has(target) && target !== item.partition ? target : null
        if (next !== dropRef.current) {
          dropRef.current = next
          stream.setDrop(next)
        }
      }}
      onDragEnd={() => {
        const target = dropRef.current
        dropRef.current = null
        stream.setDragging(null)
        stream.setDrop(null)
        if (target) moveTo(target as ItemPartition)
      }}
      className="relative min-w-0"
    >
      <CardShell state={state} fresh={fresh} open={open} className="group/card">
        {canMove && (
          <button
            type="button"
            aria-label="拖到分区以重新归类"
            title="拖到右侧分区即可重新归类"
            onPointerDown={(e) => controls.start(e)}
            className="absolute top-3 -left-3 z-10 hidden h-8 w-5 touch-none items-center justify-center rounded-md border bg-card text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover/card:opacity-100 hover:text-foreground active:cursor-grabbing xl:flex"
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="block w-full rounded-2xl p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <div className="flex items-center justify-between gap-3">
            <SourceMeta source={item.source} code={item.code} at={item.createdAt} />
            <span data-stamp className="shrink-0">
              <StatusChip item={item} state={state} />
            </span>
          </div>
          <ItemBody item={item} state={state} open={open} />
          <div className="flex items-end justify-between gap-3">
            <Journey steps={itemJourney(item, state)} />
            <ChevronDownIcon
              className={cn('mb-0.5 size-4 shrink-0 text-muted-foreground/70 transition-transform duration-300', open && 'rotate-180')}
            />
          </div>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="more"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 320, damping: 34 }}
              className="overflow-hidden"
            >
              <ItemDetails item={item} state={state} onMove={moveTo} />
            </motion.div>
          )}
        </AnimatePresence>
      </CardShell>
    </motion.div>
  )
}

function ItemBody({ item, state, open }: { item: Item; state: CardState; open: boolean }) {
  const raw = item.text.trim()
  // 识别前标题就是原文的第一行；只有图片、文件的消息原文为空，用后端给的标题（附件名等）
  const headline = (state === 'processing' || state === 'failed' ? raw || item.title : item.title || raw) || '（空消息）'
  const showRaw = raw && raw !== headline && !item.link
  const atts = item.attachments
  return (
    <div className="mt-2.5">
      <p className={cn('text-[15px] leading-snug font-medium break-words', !open && 'line-clamp-2')}>{headline}</p>
      {showRaw && (
        <p className={cn('mt-1 text-sm leading-relaxed whitespace-pre-wrap break-words text-muted-foreground', !open && 'line-clamp-2')}>
          {raw}
        </p>
      )}
      {item.link && (
        <span className="mt-2.5 flex items-center gap-2.5 rounded-xl border bg-muted/40 p-2">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-xs font-semibold shadow-xs">
            {item.link.site.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{item.link.title || item.link.site}</span>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{item.link.url}</span>
          </span>
        </span>
      )}
      {atts.length > 0 && (
        <span className="mt-2.5 flex gap-2">
          {atts.slice(0, 4).map((a) => (
            <Thumb key={a.id} att={a} className="size-16 shrink-0 rounded-xl border" />
          ))}
          {atts.length > 4 && (
            <span className="flex size-16 items-center justify-center rounded-xl border bg-muted text-xs text-muted-foreground">
              +{atts.length - 4}
            </span>
          )}
        </span>
      )}
      {item.tags.length > 0 && <TagList tags={item.tags} className="mt-2.5" />}
    </div>
  )
}

function ItemDetails({ item, state, onMove }: { item: Item; state: CardState; onMove: (p: ItemPartition) => void }) {
  const openItem = useOpenItem()
  const retry = useRetryItem()
  const toggle = useToggleTodo()
  const r = item.reminder
  return (
    <div className="space-y-3 border-t border-dashed px-4 pt-3 pb-4">
      {item.summary && (
        <p className="flex gap-2 rounded-xl bg-muted/50 p-3 text-sm leading-relaxed">
          <SparklesIcon className="mt-0.5 size-4 shrink-0 text-brand" />
          <span>{item.summary}</span>
        </p>
      )}
      {state === 'failed' && item.processing?.error && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{item.processing.error}</p>
      )}
      {item.attachments.length > 0 && (
        <div className="-mx-2">
          {item.attachments.map((a) => (
            <AttachmentRow key={a.id} att={a} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {item.partition === 'todo' && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={Boolean(item.todo?.doneAt)}
              onCheckedChange={(v) => toggle.mutate({ id: item.id, done: v === true })}
              className="size-[18px] rounded-full data-checked:border-emerald-500 data-checked:bg-emerald-500"
            />
            {item.todo?.doneAt ? '已完成' : '标记完成'}
          </label>
        )}
        {item.partition === 'reminder' && r && (
          <span className="text-sm text-muted-foreground">
            {dayLabel(r.remindAt)} {hm(r.remindAt)}
            {r.repeat !== 'none' && ` · ${REPEAT_LABEL[r.repeat]}`} · {reminderStatus(r).short}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {state === 'failed' && (
            <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(item.id)}>
              <RotateCwIcon />
              重新识别
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={state === 'processing'}>
                移到…
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">移到分区</DropdownMenuLabel>
              {MOVABLE_PARTITIONS.filter((p) => p.key !== item.partition).map((p) => (
                <DropdownMenuItem key={p.key} onSelect={() => onMove(p.key)}>
                  <p.icon className={p.text} />
                  {p.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="secondary" onClick={() => openItem(item.id)}>
            详情
            <ArrowUpRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---- 密钥 ----

function SecretCard({ secret, fresh }: { secret: Secret; fresh: boolean }) {
  return (
    <CardShell state="sorted" fresh={fresh} open={false} className="overflow-hidden">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,transparent_0_10px,color-mix(in_oklch,var(--p-secret)_5%,transparent)_10px_11px)]"
      />
      <div className="relative p-4">
        <div className="flex items-center justify-between gap-3">
          <SourceMeta source={secret.source ?? 'qq'} code={secret.code} at={secret.createdAt} />
          <PartitionStamp partition="secret" sourceKey={secret.id} />
        </div>
        <div className="mt-2.5 flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <LockIcon className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-medium">{secret.label}</p>
            <p className="text-xs text-muted-foreground">
              内容已加密，二级密码解锁后才能查看{secret.detected && ` · 自动识别：${secret.detected}`}
            </p>
          </div>
        </div>
        <div className="flex items-end justify-between gap-3">
          <Journey
            steps={[
              { label: `收到 ${hm(secret.createdAt)}`, status: 'done' },
              { label: '识别为密钥', status: 'done', color: partitionTone('secret') },
              { label: '加密入库', status: 'done', color: partitionTone('secret') },
            ]}
          />
          <Link
            to="/secrets"
            className="mb-0.5 inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <KeyRoundIcon className="size-3.5" />
            密钥库
          </Link>
        </div>
      </div>
    </CardShell>
  )
}
