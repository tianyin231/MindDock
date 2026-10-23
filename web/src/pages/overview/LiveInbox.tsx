import {
  ArrowRightIcon,
  AudioLinesIcon,
  FileIcon,
  FilmIcon,
  ImageIcon,
  InboxIcon,
  KeyRoundIcon,
  LinkIcon,
  MessageCircleIcon,
  PauseIcon,
  PlayIcon,
  SendIcon,
  SparklesIcon,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useNavigate } from 'react-router'
import { isDemo } from '@/api/client'
import { PartitionIcon } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLiveSort, type CardKind, type LiveCard, type Recent } from '@/live/live-sort'
import { useOpenItem } from '@/lib/open-item'
import { PARTITION } from '@/lib/partitions'
import { cn } from '@/lib/utils'

const KIND_ICON: Record<CardKind, LucideIcon> = {
  text: MessageCircleIcon,
  link: LinkIcon,
  image: ImageIcon,
  video: FilmIcon,
  audio: AudioLinesIcon,
  file: FileIcon,
  secret: KeyRoundIcon,
}

/** 实时收件流：新消息从这里出现，归类后飞向上方的分区格子 */
export function LiveInbox({ className }: { className?: string }) {
  const { cards, recents, auto, setAuto, simulate } = useLiveSort()

  return (
    <section className={cn('flex flex-col rounded-2xl border bg-card shadow-xs', className)}>
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          <h2 className="text-sm font-semibold">实时收件</h2>
          <span className="hidden text-xs text-muted-foreground sm:inline">QQ → MindDock</span>
        </div>
        {isDemo && (
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setAuto(!auto)}
                  aria-label={auto ? '暂停自动演示' : '开始自动演示'}
                >
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

      <div className="flex min-h-60 flex-col gap-2 p-3">
        {cards.length === 0 ? <Waiting /> : cards.map((card) => <LiveCardView key={card.id} card={card} />)}
      </div>

      {recents.length > 0 && (
        <div className="border-t p-3">
          <p className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">刚刚归类</p>
          <ul>
            <AnimatePresence initial={false}>
              {recents.map((r) => (
                <RecentRow key={r.id} recent={r} />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      )}
    </section>
  )
}

function LiveCardView({ card }: { card: LiveCard }) {
  const Icon = KIND_ICON[card.kind]
  const target = card.target ? PARTITION[card.target] : null

  return (
    <motion.div
      layoutId={`live-${card.id}`}
      initial={{ opacity: 0, y: -16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      style={{ borderRadius: 12 }}
      className={cn(
        'relative overflow-hidden border bg-background p-3 shadow-sm transition-colors',
        target && target.border,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
            target ? cn(target.soft, target.text) : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm break-all">{card.preview}</p>
          <div className="mt-1.5 h-5">
            {card.stage === 'processing' ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <SparklesIcon className="size-3.5 animate-pulse text-violet-500" />
                AI 正在识别…
              </span>
            ) : (
              target && (
                <motion.span
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  className={cn('inline-flex max-w-full items-center gap-1 text-xs font-medium', target.text)}
                >
                  <ArrowRightIcon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    归入「{target.label}」{card.title !== card.preview && ` · ${card.title}`}
                  </span>
                </motion.span>
              )
            )}
          </div>
        </div>
      </div>
      {card.stage === 'processing' && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-scan bg-gradient-to-r from-transparent via-violet-500 to-transparent" />
        </div>
      )}
    </motion.div>
  )
}

function RecentRow({ recent }: { recent: Recent }) {
  const openItem = useOpenItem()
  const navigate = useNavigate()
  const open = () => (recent.itemId ? openItem(recent.itemId) : navigate(PARTITION[recent.target].path))

  return (
    <motion.li layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
      <button
        type="button"
        onClick={open}
        className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left text-sm transition-colors hover:bg-muted/60"
      >
        <PartitionIcon partition={recent.target} className="size-6 rounded-md" iconClassName="size-3.5" />
        <span className="flex-1 truncate">{recent.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{PARTITION[recent.target].label}</span>
      </button>
    </motion.li>
  )
}

function Waiting() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6 text-center">
      <span className="relative flex size-12 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-violet-500/15 [animation-duration:2.2s]" />
        <span className="relative flex size-12 items-center justify-center rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <InboxIcon className="size-5" />
        </span>
      </span>
      <p className="text-sm font-medium">等待新消息</p>
      <p className="max-w-64 text-xs text-muted-foreground">
        在 QQ 里把文字、链接、图片或文件发给 MindDock 机器人，这里会实时显示归类过程
      </p>
    </div>
  )
}
