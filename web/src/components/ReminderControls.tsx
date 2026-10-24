import { BellOffIcon, CheckIcon, ChevronDownIcon, ClockIcon, PencilIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { useReminderAction } from '@/api/hooks'
import type { Item, ReminderAction, ReminderInfo, RepeatRule } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { dayLabel, hm, REPEAT_LABEL } from '@/lib/format'
import { reminderStatus } from '@/lib/reminder-status'
import { cn } from '@/lib/utils'

const SNOOZE = [
  { minutes: 10, label: '10 分钟后' },
  { minutes: 30, label: '30 分钟后' },
  { minutes: 60, label: '1 小时后' },
  { minutes: 180, label: '3 小时后' },
  { minutes: 1440, label: '明天这个时候' },
]

const REPEAT_OPTIONS: { value: RepeatRule; label: string }[] = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]

const TONE_CLASS = {
  pending: 'text-muted-foreground',
  ok: 'text-emerald-600 dark:text-emerald-400',
  muted: 'text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-destructive',
} as const

const pad = (n: number) => String(n).padStart(2, '0')

/** 时间 → datetime-local 输入框的值（本地时区） */
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 新设提醒的默认时间：一小时后的整点 */
function nextHour(): string {
  const d = new Date(Date.now() + 3_600_000)
  d.setMinutes(0, 0, 0)
  return d.toISOString()
}

/** 详情抽屉里的提醒：状态说明，完成、延后、改时间、取消 */
export function ReminderControls({ item }: { item: Item }) {
  const r = item.reminder
  const action = useReminderAction()
  const [editing, setEditing] = useState(!r)

  const run = (body: ReminderAction, message: string) =>
    action.mutate(
      { id: item.id, body },
      {
        onSuccess: () => {
          toast.success(message)
          setEditing(false)
        },
        onError: (err) => toast.error(err.message),
      },
    )

  const active = r && ['scheduled', 'sent', 'failed'].includes(r.status)
  const status = r ? reminderStatus(r) : null

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      {r && status ? (
        <div className="space-y-0.5">
          <p className="font-medium">
            {dayLabel(r.remindAt)} {hm(r.remindAt)}
            {r.repeat !== 'none' && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">{REPEAT_LABEL[r.repeat]}重复</span>
            )}
          </p>
          <p className={cn('text-xs break-words', TONE_CLASS[status.tone])}>{status.long}</p>
        </div>
      ) : (
        <p className="text-muted-foreground">还没有提醒时间，设置后到点通过 QQ 提醒你</p>
      )}

      {editing ? (
        <ReminderEditor
          initial={r}
          pending={action.isPending}
          onCancel={r ? () => setEditing(false) : undefined}
          onSave={(remindAt, repeat) =>
            run({ action: 'reschedule', remind_at: remindAt, repeat }, r ? '提醒时间已更新' : '提醒已设置')
          }
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {active && r.repeat === 'none' && (
            <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => run({ action: 'done' }, '已完成')}>
              <CheckIcon />
              完成
            </Button>
          )}
          {active && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={action.isPending}>
                  <ClockIcon />
                  稍后
                  <ChevronDownIcon className="opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {SNOOZE.map((s) => (
                  <DropdownMenuItem
                    key={s.minutes}
                    onSelect={() => run({ action: 'snooze', minutes: s.minutes }, `将在${s.label}再提醒`)}
                  >
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <PencilIcon />
            {r && r.status !== 'scheduled' ? '重新设置' : '改时间'}
          </Button>
          {r?.status === 'scheduled' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => run({ action: 'cancel' }, '已取消提醒')}
            >
              <BellOffIcon />
              取消提醒
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function ReminderEditor({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  initial?: ReminderInfo
  pending: boolean
  onSave: (remindAt: string, repeat: RepeatRule) => void
  onCancel?: () => void
}) {
  // 还没到点的提醒从原时间改起，其余从一小时后开始
  const [value, setValue] = useState(() =>
    toLocalInput(
      initial?.status === 'scheduled' && Date.parse(initial.remindAt) > Date.now() ? initial.remindAt : nextHour(),
    ),
  )
  const [repeat, setRepeat] = useState<RepeatRule>(initial?.repeat ?? 'none')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const at = new Date(value)
    if (Number.isNaN(at.getTime())) {
      toast.error('请选择提醒时间')
      return
    }
    if (at.getTime() < Date.now()) {
      toast.error('提醒时间已经过去了')
      return
    }
    onSave(at.toISOString(), repeat)
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          type="datetime-local"
          aria-label="提醒时间"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          className="min-w-0 flex-1"
        />
        <Select value={repeat} onValueChange={(v) => setRepeat(v as RepeatRule)}>
          <SelectTrigger className="w-24 shrink-0" aria-label="重复">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPEAT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" size="sm" disabled={pending}>
          保存
        </Button>
      </div>
    </form>
  )
}
