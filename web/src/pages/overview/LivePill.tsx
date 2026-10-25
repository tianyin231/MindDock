import { ArrowRightIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { Link } from 'react-router'
import { useTimeline } from '@/api/hooks'
import { entryId } from '@/api/timeline-cache'
import type { TimelineEntry } from '@/api/types'
import { ORIGIN, useFlightSource } from '@/live/live'
import { relativeTime } from '@/lib/format'
import { PARTITION, partitionTone } from '@/lib/partitions'
import { cn } from '@/lib/utils'

function describe(e: TimelineEntry) {
  if (e.kind === 'secret') return { processing: false, title: e.secret.label, partition: 'secret' as const, at: e.secret.createdAt }
  const processing = e.item.processing?.stage === 'organizing'
  return { processing, title: (processing && e.item.text) || e.item.title, partition: e.item.partition, at: e.item.createdAt }
}

/** 总览右上角的收件台入口：显示最新一条及其状态，新消息到来时文字向上滚动替换，也是飞行动画的起点 */
export function LivePill({ className }: { className?: string }) {
  const { data } = useTimeline()
  const originRef = useFlightSource(ORIGIN, 2)
  const latest = data?.pages[0]?.entries[0]
  const info = latest ? describe(latest) : null

  return (
    <Link
      to="/stream"
      className={cn(
        'surface group flex h-11 max-w-full min-w-0 items-center gap-3 rounded-full pr-1.5 pl-4 transition-shadow hover:surface-lift sm:w-[26rem]',
        className,
      )}
    >
      <span ref={originRef} className="relative flex size-2 shrink-0">
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-70',
            info?.processing ? 'bg-brand' : 'bg-emerald-400',
          )}
        />
        <span className={cn('relative inline-flex size-2 rounded-full', info?.processing ? 'bg-brand' : 'bg-emerald-500')} />
      </span>
      <span className="shrink-0 text-xs font-semibold">收件台</span>
      <span className="h-4 w-px shrink-0 bg-border" />
      <span className="relative h-5 min-w-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={latest ? `${entryId(latest)}-${info?.partition}` : 'empty'}
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -18, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="absolute inset-0 flex items-center gap-2 text-xs"
          >
            {!info ? (
              <span className="text-muted-foreground">等待第一条消息</span>
            ) : info.processing ? (
              <span className="truncate shimmer-text">正在识别：{info.title}</span>
            ) : (
              <>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: partitionTone(info.partition) }} />
                <span className="truncate text-foreground/80">{info.title}</span>
                <span className="shrink-0 text-muted-foreground">
                  {PARTITION[info.partition].label} · {relativeTime(info.at)}
                </span>
              </>
            )}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform group-hover:translate-x-0.5">
        <ArrowRightIcon className="size-4" />
      </span>
    </Link>
  )
}
