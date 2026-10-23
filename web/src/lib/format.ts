const DAY = 86_400_000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad = (n: number) => String(n).padStart(2, '0')

function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

/** 与今天相差的自然日数：0 今天，1 明天，-1 昨天 */
export function dayDiff(iso: string, now = new Date()): number {
  return Math.round((startOfDay(new Date(iso)) - startOfDay(now)) / DAY)
}

export function hm(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function monthDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 今天 / 明天 / 昨天 / 后天 / 10月28日 周二 */
export function dayLabel(iso: string, now = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  if (diff === 2) return '后天'
  return `${monthDay(iso)} ${WEEKDAYS[new Date(iso).getDay()]}`
}

/** 窄位置用的短日期：今天 / 明天 / 后天 / 昨天 / 10/28 */
export function shortDay(iso: string, now = new Date()): string {
  const diff = dayDiff(iso, now)
  if (diff >= -1 && diff <= 2) return dayLabel(iso, now)
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 昨天 21:30 / 10月20日 */
export function relativeTime(iso: string, now = new Date()): string {
  const seconds = (now.getTime() - Date.parse(iso)) / 1000
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} 分钟前`
  const diff = dayDiff(iso, now)
  if (diff === 0) return `${Math.floor(seconds / 3600)} 小时前`
  if (diff === -1) return `昨天 ${hm(iso)}`
  return monthDay(iso)
}

export type DueTone = 'overdue' | 'today' | 'soon' | 'later'

export function dueLabel(iso: string, now = new Date()): { label: string; tone: DueTone } {
  const diff = dayDiff(iso, now)
  if (diff < 0) return { label: `逾期 ${-diff} 天`, tone: 'overdue' }
  if (diff === 0) return { label: `今天 ${hm(iso)}`, tone: 'today' }
  if (diff === 1) return { label: '明天', tone: 'soon' }
  if (diff < 7) return { label: WEEKDAYS[new Date(iso).getDay()], tone: 'later' }
  return { label: monthDay(iso), tone: 'later' }
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function duration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${pad(Math.round(seconds % 60))}`
}

export function greeting(now = new Date()): string {
  const h = now.getHours()
  if (h < 5) return '夜深了'
  if (h < 9) return '早上好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

export function fullDate(now = new Date()): string {
  return `${now.getMonth() + 1}月${now.getDate()}日 星期${'日一二三四五六'[now.getDay()]}`
}

export const REPEAT_LABEL = { none: '', daily: '每天', weekly: '每周', monthly: '每月' } as const
