import { ArrowUpRightIcon, RadioTowerIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import { useCounts, useItems } from '@/api/hooks'
import type { PartitionKey } from '@/api/types'
import { AnimatedCount } from '@/components/common'
import { Skeleton } from '@/components/ui/skeleton'
import { LandingPulse } from '@/live/LandingPulse'
import { useBump, useFlightTarget } from '@/live/live'
import { dayLabel, hm } from '@/lib/format'
import { PARTITIONS, partitionTone, type PartitionMeta } from '@/lib/partitions'
import { cn } from '@/lib/utils'

/** 七个分区合成一块面板，细线分隔：数量、一句话状态，也是归类动画的落点 */
export function PartitionStrip() {
  const { data: counts } = useCounts()
  const todos = useItems('todo').data ?? []
  const reminders = useItems('reminder').data ?? []
  const files = useItems('file').data ?? []
  const inbox = useItems('inbox').data ?? []

  const processing = inbox.filter((i) => i.processing?.stage === 'organizing').length
  const openTodos = todos.filter((t) => !t.todo?.doneAt).length
  const next = reminders.find((r) => r.reminder?.status === 'scheduled')?.reminder
  const pendingUploads = files.filter((f) => f.attachments.some((a) => a.uploadStatus !== 'uploaded')).length
  const waiting = Math.max(0, (counts?.inbox ?? 0) - processing)

  const subtitle: Record<PartitionKey, string> = {
    inbox: processing > 0 ? `${processing} 条正在识别` : waiting > 0 ? `${waiting} 条需手动处理` : '全部已归类',
    note: '想法与随手记',
    bookmark: '网址与文章',
    todo: `${openTodos} 项未完成`,
    reminder: next ? `下一个 ${dayLabel(next.remindAt)} ${hm(next.remindAt)}` : '暂无提醒',
    secret: '已加密保存',
    file: pendingUploads > 0 ? `${pendingUploads} 个待上传` : '原件已存夸克',
  }

  return (
    <section aria-label="分区" className="surface overflow-hidden rounded-2xl">
      {/* gap-px + 底色 = 各方向都有的细分隔线；窄屏 4 列时补一个收件台入口凑满两行 */}
      <div className="grid grid-cols-4 gap-px bg-border xl:grid-cols-7">
        {PARTITIONS.map((meta) => (
          <Cell key={meta.key} meta={meta} count={counts?.[meta.key]} subtitle={subtitle[meta.key]} />
        ))}
        <Link
          to="/stream"
          className="group flex flex-col justify-between gap-3 bg-card p-3 transition-colors hover:bg-muted/50 sm:p-4 xl:hidden"
        >
          <span className="flex size-7 items-center justify-center rounded-lg bg-brand/10 text-brand">
            <RadioTowerIcon className="size-4" />
          </span>
          <span>
            <span className="block text-[13px] font-medium">收件台</span>
            <span className="hidden text-xs text-muted-foreground sm:block">看完整归类过程</span>
          </span>
        </Link>
      </div>
    </section>
  )
}

function Cell({ meta, count, subtitle }: { meta: PartitionMeta; count?: number; subtitle: string }) {
  const Icon = meta.icon
  const targetRef = useFlightTarget(meta.key, 2)
  const bump = useBump(meta.key)
  return (
    <Link
      ref={targetRef}
      to={meta.path}
      className="group relative flex flex-col gap-3 bg-card p-3 transition-colors hover:bg-muted/40 sm:gap-4 sm:p-4"
    >
      <LandingPulse partition={meta.key} />
      <div className="flex items-center justify-between">
        <motion.span
          key={bump}
          initial={bump > 0 ? { scale: 1.4, rotate: -8 } : false}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 420, damping: 12 }}
          className={cn('flex size-7 items-center justify-center rounded-lg', meta.soft, meta.text)}
        >
          <Icon className="size-4" />
        </motion.span>
        <ArrowUpRightIcon className="hidden size-3.5 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100 sm:block" />
      </div>
      <div className="min-w-0">
        <div className="text-[22px] leading-none font-semibold tracking-tight sm:text-[26px]">
          {count === undefined ? <Skeleton className="h-6 w-10" /> : <AnimatedCount value={count} />}
        </div>
        <div className="mt-1.5 text-[13px] font-medium">{meta.label}</div>
        <div className="hidden truncate text-xs text-muted-foreground sm:block">{subtitle}</div>
      </div>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left scale-x-0 transition-transform duration-300 group-hover:scale-x-100"
        style={{ background: partitionTone(meta.key) }}
      />
    </Link>
  )
}
