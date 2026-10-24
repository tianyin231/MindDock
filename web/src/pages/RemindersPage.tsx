import { AlarmClockIcon, MailIcon, MessageCircleIcon, TerminalIcon } from 'lucide-react'
import { useItems } from '@/api/hooks'
import type { Item } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { ReminderRow } from '@/components/items'
import { Skeleton } from '@/components/ui/skeleton'
import { dayDiff } from '@/lib/format'

const GROUPS = [
  { key: 'unset', label: '未设置时间' },
  { key: 'failed', label: '发送失败' },
  { key: 'today', label: '今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'later', label: '之后' },
  { key: 'sent', label: '已送达' },
  { key: 'done', label: '已完成' },
  { key: 'cancelled', label: '已取消' },
] as const

function groupOf(item: Item): (typeof GROUPS)[number]['key'] {
  const r = item.reminder
  if (!r) return 'unset'
  if (r.status !== 'scheduled') return r.status
  // 还没发出去的过期提醒（正在重试）也放在今天
  const diff = dayDiff(r.remindAt)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'tomorrow'
  return 'later'
}

export function RemindersPage() {
  const { data, isLoading } = useItems('reminder')
  const all = data ?? []
  const scheduled = all.filter((i) => i.reminder?.status === 'scheduled').length

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader partition="reminder" count={scheduled} />

      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <MessageCircleIcon className="size-3.5 text-rose-500" />
          到点由 QQ 机器人提醒你
        </span>
        <span className="flex items-center gap-1.5">
          <MailIcon className="size-3.5" />
          QQ 发不出去时改发邮件（需在设置中配置）
        </span>
        <span className="flex items-center gap-1.5">
          <TerminalIcon className="size-3.5" />
          在 QQ 回复 /done 完成，/later 30m 稍后再提醒
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState icon={AlarmClockIcon} title="没有提醒" hint="在 QQ 里发「明天下午三点提醒我交报告」试试" />
      ) : (
        GROUPS.map((g) => {
          const items = all.filter((i) => groupOf(i) === g.key)
          if (items.length === 0) return null
          return (
            <section key={g.key} className="rounded-2xl border bg-card p-3 shadow-xs">
              <h2 className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
                {g.label} <span className="font-normal">{items.length}</span>
              </h2>
              {items.map((i) => (
                <ReminderRow key={i.id} item={i} />
              ))}
            </section>
          )
        })
      )}
    </div>
  )
}
