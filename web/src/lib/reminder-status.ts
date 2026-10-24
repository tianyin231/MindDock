import type { ReminderInfo } from '@/api/types'
import { relativeTime } from '@/lib/format'

export type ReminderTone = 'pending' | 'ok' | 'muted' | 'warn' | 'error'

/** 提醒的状态说明：short 用于列表，long 用于详情 */
export function reminderStatus(r: ReminderInfo): { short: string; long: string; tone: ReminderTone } {
  const via = r.channel === 'email' ? '邮件' : ' QQ '
  switch (r.status) {
    case 'sent':
      return {
        short: `已通过${via}送达`,
        long: `已通过${via}送达${r.sentAt ? ` · ${relativeTime(r.sentAt)}` : ''}`,
        tone: 'ok',
      }
    case 'done':
      return { short: '已完成', long: `已完成${r.doneAt ? ` · ${relativeTime(r.doneAt)}` : ''}`, tone: 'ok' }
    case 'cancelled':
      return { short: '已取消', long: '已取消，不会再提醒', tone: 'muted' }
    case 'failed':
      return { short: '发送失败', long: `发送失败：${r.lastError ?? '原因未知'}`, tone: 'error' }
    default:
      if (r.lastError) return { short: '发送失败，正在重试', long: `发送失败，正在重试：${r.lastError}`, tone: 'warn' }
      if (r.repeat !== 'none' && r.sentAt)
        return { short: '到点 QQ 提醒', long: `上次已通过${via}送达 · ${relativeTime(r.sentAt)}`, tone: 'pending' }
      return { short: '到点 QQ 提醒', long: '到点通过 QQ 提醒，QQ 发不出去时改发邮件', tone: 'pending' }
  }
}
