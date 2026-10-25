import { AlarmClockIcon, ArrowRightIcon, ChevronRightIcon, CircleCheckIcon, LockIcon, SparklesIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useItems, useTimeline } from '@/api/hooks'
import { entryId } from '@/api/timeline-cache'
import type { ItemPartition, TimelineEntry } from '@/api/types'
import { EmptyState, PartitionIcon } from '@/components/common'
import { BookmarkCard, FileTile, NoteCard, ReminderRow, TodoRow } from '@/components/items'
import { Skeleton } from '@/components/ui/skeleton'
import { dayDiff, dayLabel, fullDate, greeting, hm, relativeTime } from '@/lib/format'
import { useOpenItem } from '@/lib/open-item'
import { PARTITION } from '@/lib/partitions'
import { cn } from '@/lib/utils'
import { LivePill } from './LivePill'
import { PartitionStrip } from './PartitionStrip'
import { SetupChecklist } from './SetupChecklist'

const rise = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: 0.06 * i, type: 'spring' as const, stiffness: 220, damping: 28 },
})

export function OverviewPage() {
  return (
    <div className="space-y-6">
      <Hero />
      <SetupChecklist />
      <motion.div {...rise(1)}>
        <PartitionStrip />
      </motion.div>
      <div className="grid gap-6 lg:grid-cols-12">
        <motion.div {...rise(2)} className="lg:col-span-7">
          <TodayPanel />
        </motion.div>
        <motion.div {...rise(3)} className="lg:col-span-5">
          <RecentPanel />
        </motion.div>
      </div>
      <motion.div {...rise(4)}>
        <LibraryPanel />
      </motion.div>
    </div>
  )
}

function Hero() {
  const todos = useItems('todo').data ?? []
  const reminders = useItems('reminder').data ?? []
  const due = todos.filter((t) => !t.todo?.doneAt && t.todo?.dueAt && dayDiff(t.todo.dueAt) <= 0).length
  const next = reminders.find((r) => r.reminder?.status === 'scheduled')
  const parts = [
    due > 0 ? `今天有 ${due} 项待办到期` : '今天没有到期的待办',
    next?.reminder && `下一个提醒 ${dayLabel(next.reminder.remindAt)} ${hm(next.reminder.remindAt)} · ${next.title}`,
  ].filter(Boolean)

  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <motion.div {...rise(0)} className="min-w-0">
        <p className="eyebrow">{fullDate()}</p>
        <h1 className="mt-1.5 text-[30px] leading-tight font-semibold tracking-tight sm:text-[34px]">{greeting()}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{parts.join('，')}</p>
      </motion.div>
      <motion.div {...rise(1)} className="w-full min-w-0 sm:w-auto">
        <LivePill className="w-full" />
      </motion.div>
    </header>
  )
}

function Panel({
  title,
  meta,
  action,
  children,
  className,
}: {
  title: string
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('surface flex h-full flex-col rounded-2xl', className)}>
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 className="flex items-baseline gap-2 text-[15px] font-semibold tracking-tight">
          {title}
          {meta && <span className="text-xs font-normal text-muted-foreground">{meta}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function MoreLink({ to, label = '全部' }: { to: string; label?: string }) {
  return (
    <Link to={to} className="flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground">
      {label}
      <ChevronRightIcon className="size-3.5" />
    </Link>
  )
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full rounded-lg" />
      ))}
    </div>
  )
}

// ---- 今日安排：提醒与待办并排 ----

function TodayPanel() {
  const todoQuery = useItems('todo')
  const reminderQuery = useItems('reminder')
  const todos = todoQuery.data ?? []
  // 今天到期 / 已逾期的未完成项，加上今天刚完成的（保留删除线，让勾选有反馈）
  const todayTodos = todos.filter((i) =>
    i.todo?.doneAt ? dayDiff(i.todo.doneAt) === 0 : i.todo?.dueAt !== undefined && dayDiff(i.todo.dueAt) <= 0,
  )
  const open = todos.filter((i) => !i.todo?.doneAt).length
  const upcoming = (reminderQuery.data ?? []).filter((i) => i.reminder?.status === 'scheduled').slice(0, 4)

  return (
    <Panel title="今日安排" meta={`${open} 项待办未完成`}>
      <div className="grid flex-1 sm:grid-cols-2 sm:divide-x">
        <div className="px-3 pb-3 sm:pb-4">
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
            <h3 className="eyebrow">即将提醒</h3>
            <MoreLink to="/reminders" />
          </div>
          {reminderQuery.isLoading ? (
            <ListSkeleton />
          ) : upcoming.length === 0 ? (
            <EmptyState icon={AlarmClockIcon} title="没有待发送的提醒" className="py-6" />
          ) : (
            upcoming.map((i) => <ReminderRow key={i.id} item={i} />)
          )}
        </div>
        <div className="border-t px-3 pb-4 sm:border-t-0">
          <div className="flex items-center justify-between px-2 pt-3 pb-1.5 sm:pt-1">
            <h3 className="eyebrow">今日待办</h3>
            <MoreLink to="/todos" />
          </div>
          {todoQuery.isLoading ? (
            <ListSkeleton />
          ) : todayTodos.length === 0 ? (
            <EmptyState icon={CircleCheckIcon} title="今天没有到期的待办" className="py-6" />
          ) : (
            <AnimatePresence initial={false}>
              {todayTodos.map((i) => (
                <TodoRow key={i.id} item={i} />
              ))}
            </AnimatePresence>
          )}
        </div>
      </div>
    </Panel>
  )
}

// ---- 刚刚收进来：收件台最新几条的摘要 ----

function RecentPanel() {
  const { data, isLoading } = useTimeline()
  const entries = data?.pages[0]?.entries.slice(0, 6) ?? []
  return (
    <Panel title="刚刚收进来" action={<MoreLink to="/stream" label="收件台" />}>
      <div className="flex-1 px-3 pb-2">
        {isLoading ? (
          <ListSkeleton rows={5} />
        ) : entries.length === 0 ? (
          <EmptyState icon={SparklesIcon} title="还没有收到内容" hint="把消息发给 QQ 机器人，或在收件台里直接写" className="py-8" />
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {entries.map((e) => (
                <RecentRow key={entryId(e)} entry={e} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <Link
        to="/stream"
        className="group mx-3 mb-3 flex items-center justify-between rounded-xl bg-muted/60 px-3.5 py-2.5 text-xs font-medium transition-colors hover:bg-muted"
      >
        打开收件台，查看每条内容的归类过程
        <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </Panel>
  )
}

function RecentRow({ entry }: { entry: TimelineEntry }) {
  const openItem = useOpenItem()
  const navigate = useNavigate()
  const isSecret = entry.kind === 'secret'
  const processing = !isSecret && entry.item.processing?.stage === 'organizing'
  const partition = isSecret ? 'secret' : entry.item.partition
  const title = isSecret ? entry.secret.label : (processing && entry.item.text) || entry.item.title
  const at = isSecret ? entry.secret.createdAt : entry.item.createdAt

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -10, filter: 'blur(4px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <button
        type="button"
        onClick={() => (isSecret ? navigate('/secrets') : openItem(entry.item.id))}
        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-muted/60"
      >
        {processing ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <SparklesIcon className="size-4 animate-pulse" />
          </span>
        ) : (
          <PartitionIcon partition={partition} className="size-8" />
        )}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-sm', processing && 'shimmer-text')}>{title}</span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {isSecret && <LockIcon className="size-3" />}
            {processing ? 'AI 正在识别' : PARTITION[partition].label}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{relativeTime(at)}</span>
      </button>
    </motion.li>
  )
}

// ---- 资料库：收藏 / 笔记 / 文件 用标签页切换，代替三块堆叠的区域 ----

const LIBRARY: { key: Extract<ItemPartition, 'bookmark' | 'note' | 'file'>; label: string }[] = [
  { key: 'bookmark', label: '最近收藏' },
  { key: 'note', label: '最近笔记' },
  { key: 'file', label: '最近文件' },
]

function LibraryPanel() {
  const [tab, setTab] = useState<(typeof LIBRARY)[number]['key']>('bookmark')
  return (
    <section className="surface rounded-2xl">
      <div className="flex items-center justify-between gap-3 border-b px-3 sm:px-5">
        <div role="tablist" aria-label="资料库" className="-mb-px flex">
          {LIBRARY.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'relative px-2.5 py-3.5 text-sm transition-colors sm:px-3',
                tab === t.key ? 'font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
              {tab === t.key && (
                <motion.span
                  layoutId="library-tab"
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-foreground"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
            </button>
          ))}
        </div>
        <MoreLink to={PARTITION[tab].path} />
      </div>
      <div className="p-3 sm:p-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <LibraryContent partition={tab} />
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  )
}

function LibraryContent({ partition }: { partition: 'bookmark' | 'note' | 'file' }) {
  const { data, isLoading } = useItems(partition)
  const list = data ?? []
  const meta = PARTITION[partition]

  if (!isLoading && list.length === 0) return <EmptyState icon={meta.icon} title={`还没有${meta.label}`} className="py-8" />

  if (partition === 'file') {
    return (
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
        {isLoading
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-2xl" />)
          : list.slice(0, 6).map((i) => <FileTile key={i.id} item={i} />)}
      </div>
    )
  }
  if (partition === 'note') {
    return (
      <div className="grid gap-3 max-sm:[&>*:nth-child(n+3)]:hidden md:grid-cols-3">
        {isLoading
          ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)
          : list.slice(0, 3).map((i) => <NoteCard key={i.id} item={i} />)}
      </div>
    )
  }
  return (
    // 手机上只放两张，免得总览拉得太长
    <div className="grid gap-3 max-sm:[&>*:nth-child(n+3)]:hidden sm:grid-cols-2 xl:grid-cols-4">
      {isLoading
        ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-36 rounded-2xl" />)
        : list.slice(0, 4).map((i) => <BookmarkCard key={i.id} item={i} />)}
    </div>
  )
}
