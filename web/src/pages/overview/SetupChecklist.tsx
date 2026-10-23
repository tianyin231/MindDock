import { ArrowRightIcon, CircleCheckIcon, CircleIcon } from 'lucide-react'
import { Link } from 'react-router'
import { useSettings } from '@/api/settings'
import { cn } from '@/lib/utils'

const STEPS = [
  { key: 'qq', label: 'QQ 机器人', hint: '收消息、发提醒' },
  { key: 'ai', label: 'AI 模型', hint: '自动归类与摘要' },
  { key: 'storage', label: '夸克网盘', hint: '归档原件' },
]

/** 关键设置未完成时显示在总览顶部，全部完成后自动消失 */
export function SetupChecklist() {
  const { data: sections } = useSettings()
  if (!sections) return null
  const done = STEPS.map((s) => sections.find((x) => x.key === s.key)?.configured ?? false)
  if (done.every(Boolean)) return null

  return (
    <section className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/10 to-transparent p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">还差几步就能开始使用</h2>
          <p className="text-xs text-muted-foreground">在设置里填好下面几项，每项都可以一键测试连接</p>
        </div>
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background"
        >
          去设置
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.key} className="flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-sm">
            {done[i] ? (
              <CircleCheckIcon className="size-4 text-emerald-500" />
            ) : (
              <CircleIcon className="size-4 text-muted-foreground" />
            )}
            <span className={cn('font-medium', done[i] && 'text-muted-foreground line-through')}>{s.label}</span>
            <span className="text-xs text-muted-foreground">{s.hint}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
