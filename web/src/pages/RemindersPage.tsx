import { AlarmClockIcon, MailIcon, MessageCircleIcon } from 'lucide-react'
import { useItems } from '@/api/hooks'
import type { Item } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { ReminderRow } from '@/components/items'
import { Skeleton } from '@/components/ui/skeleton'
import { dayDiff } from '@/lib/format'

const GROUPS = [
  { key: 'today', label: '今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'later', label: '之后' },
  { key: 'sent', label: '已送达' },
] as const

function groupOf(item: Item): (typeof GROUPS)[number]['key'] {
  const r = item.reminder!
  if (r.status === 'sent') return 'sent'
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
          到点由 QQ 机器人主动发消息
        </span>
        <span className="flex items-center gap-1.5">
          <MailIcon className="size-3.5" />
          发送失败时自动改发邮件
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
