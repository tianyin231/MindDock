import { ChevronRightIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Link } from 'react-router'
import { useCounts, useItems } from '@/api/hooks'
import type { PartitionKey } from '@/api/types'
import { AnimatedCount } from '@/components/common'
import { Skeleton } from '@/components/ui/skeleton'
import { useLiveSort, type Landing } from '@/live/live-sort'
import { dayLabel, hm } from '@/lib/format'
import { PARTITIONS, type PartitionMeta } from '@/lib/partitions'
import { cn } from '@/lib/utils'

/** 七个分区格子：数量、一句话状态，以及归类动画的落点 */
export function PocketTiles() {
  const { data: counts } = useCounts()
  const { cards, landings, bumps } = useLiveSort()
  const todos = useItems('todo').data ?? []
  const reminders = useItems('reminder').data ?? []
  const files = useItems('file').data ?? []

  const processing = cards.filter((c) => c.stage === 'processing').length
  const openTodos = todos.filter((t) => !t.todo?.doneAt).length
  const nextReminder = reminders.find((r) => r.reminder?.status === 'scheduled')
  const pendingUploads = files.filter((f) => f.attachments.some((a) => a.uploadStatus !== 'uploaded')).length

  const waitingManual = Math.max(0, (counts?.inbox ?? 0) - processing)
  const subtitle: Record<PartitionKey, string> = {
    inbox:
      processing > 0
        ? `${processing} 条正在识别`
        : waitingManual > 0
          ? `${waitingManual} 条需手动处理`
          : '全部已归类',
    note: '想法与随手记',
    bookmark: '网址与文章',
    todo: `${openTodos} 项未完成`,
    reminder: nextReminder
      ? `下一个 ${dayLabel(nextReminder.reminder!.remindAt)} ${hm(nextReminder.reminder!.remindAt)}`
      : '暂无提醒',
    secret: '已加密 · 已锁定',
    file: pendingUploads > 0 ? `${pendingUploads} 个待上传` : '原件已存夸克',
  }

  return (
    // 手机上每行 4 个紧凑格子，保证实时收件也在首屏附近，动画看得见
    <div className="grid grid-cols-4 gap-2 sm:gap-3 xl:grid-cols-7">
      {PARTITIONS.map((meta) => (
        <PocketTile
          key={meta.key}
          meta={meta}
          count={counts?.[meta.key]}
          subtitle={subtitle[meta.key]}
          landings={landings.filter((l) => l.target === meta.key)}
          bump={bumps[meta.key] ?? 0}
        />
      ))}
    </div>
  )
}

function PocketTile({
  meta,
  count,
  subtitle,
  landings,
  bump,
}: {
  meta: PartitionMeta
  count?: number
  subtitle: string
  landings: Landing[]
  bump: number
}) {
  const Icon = meta.icon
  return (
    // 不能用 isolate / overflow-hidden：飞入的标签要能越过其他区域显示
    <Link
      to={meta.path}
      className="group relative flex flex-col gap-2 rounded-xl border bg-card p-2.5 shadow-xs transition-shadow hover:shadow-md sm:gap-3 sm:rounded-2xl sm:p-4"
    >
      <span
        aria-hidden="true"
        className={cn('pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br to-transparent', meta.glow)}
      />
      {bump > 0 && (
        <motion.span
          key={bump}
          aria-hidden="true"
          className={cn('pointer-events-none absolute inset-0 rounded-2xl border-2', meta.border)}
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 1.08 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        />
      )}

      <div className="relative flex items-center justify-between">
        <motion.span
          key={bump}
          initial={bump > 0 ? { scale: 1.35 } : false}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 400, damping: 12 }}
          className={cn(
            'flex size-7 items-center justify-center rounded-lg sm:size-9 sm:rounded-xl',
            meta.soft,
            meta.text,
          )}
        >
          <Icon className="size-4 sm:size-[18px]" />
        </motion.span>
        <ChevronRightIcon className="hidden size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 sm:block" />
      </div>

      <div className="relative">
        <div className="text-xl leading-none font-semibold sm:text-2xl">
          {count === undefined ? <Skeleton className="h-6 w-10" /> : <AnimatedCount value={count} />}
        </div>
        <div className="mt-1 text-xs font-medium sm:mt-1.5 sm:text-sm">{meta.label}</div>
        <div className="hidden truncate text-xs text-muted-foreground sm:block">{subtitle}</div>
      </div>

      <AnimatePresence>
        {landings.map((l) => (
          <motion.div
            key={l.id}
            layoutId={`live-${l.id}`}
            style={{ borderRadius: 999 }}
            transition={{ layout: { type: 'spring', stiffness: 160, damping: 22 } }}
            exit={{ opacity: 0, scale: 0.3, transition: { duration: 0.25 } }}
            className={cn(
              'absolute top-2 left-2 z-30 flex h-7 max-w-[calc(100%-1rem)] items-center gap-1.5 px-2 text-xs font-medium text-white shadow-lg sm:top-3 sm:left-3 sm:h-8 sm:max-w-[calc(100%-1.5rem)] sm:px-3',
              meta.solid,
            )}
          >
            <motion.span layout="position" className="shrink-0">
              <Icon className="size-3.5" />
            </motion.span>
            {/* 手机格子太窄，只显示图标 */}
            <motion.span layout="position" className="hidden truncate sm:inline">
              {l.title}
            </motion.span>
          </motion.div>
        ))}
      </AnimatePresence>
    </Link>
  )
}
