import { ArrowRightIcon, CircleCheckIcon, CircleIcon } from 'lucide-react'
import { Link } from 'react-router'
import { useQQ } from '@/api/qq'
import { useSettings } from '@/api/settings'
import { cn } from '@/lib/utils'

/** 关键设置未完成时显示在总览顶部，全部完成后自动消失 */
export function SetupChecklist() {
  const { data: sections } = useSettings()
  const { data: qq } = useQQ()
  if (!sections || !qq) return null

  const configured = (key: string) => sections.find((s) => s.key === key)?.configured ?? false
  const steps = [
    { label: 'QQ 机器人', hint: '收消息、发提醒', done: configured('qq') },
    { label: 'AI 模型', hint: '自动归类与摘要', done: configured('ai') },
    { label: '夸克网盘', hint: '归档原件', done: configured('storage') },
    { label: '绑定 QQ', hint: '机器人只认你', done: qq.owner.bound },
  ]
  if (steps.every((s) => s.done)) return null

  return (
    <section className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/10 to-transparent p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">还差几步就能开始使用</h2>
          <p className="text-xs text-muted-foreground">都在设置页完成，每项都可以一键测试</p>
        </div>
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-xs font-medium text-background"
        >
          去设置
          <ArrowRightIcon className="size-3.5" />
        </Link>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s) => (
          <div key={s.label} className="flex items-center gap-2 rounded-lg bg-background/70 px-3 py-2 text-sm">
            {s.done ? (
              <CircleCheckIcon className="size-4 shrink-0 text-emerald-500" />
            ) : (
              <CircleIcon className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className={cn('font-medium', s.done && 'text-muted-foreground line-through')}>{s.label}</span>
            <span className="truncate text-xs text-muted-foreground">{s.hint}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
