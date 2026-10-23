import { ChevronDownIcon, CircleCheckIcon, ListTodoIcon, PlusIcon } from 'lucide-react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useState, type FormEvent } from 'react'
import { useAddTodo, useItems } from '@/api/hooks'
import type { Item } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { TodoRow } from '@/components/items'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { dayDiff } from '@/lib/format'
import { cn } from '@/lib/utils'

const GROUPS = [
  { key: 'overdue', label: '已逾期', tone: 'text-destructive' },
  { key: 'today', label: '今天', tone: 'text-amber-600 dark:text-amber-400' },
  { key: 'upcoming', label: '接下来', tone: 'text-foreground' },
  { key: 'someday', label: '无截止时间', tone: 'text-muted-foreground' },
] as const

type GroupKey = (typeof GROUPS)[number]['key']

function groupOf(item: Item): GroupKey {
  const due = item.todo?.dueAt
  if (!due) return 'someday'
  const diff = dayDiff(due)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  return 'upcoming'
}

export function TodosPage() {
  const { data, isLoading } = useItems('todo')
  const [showDone, setShowDone] = useState(true)
  const all = data ?? []
  const open = all.filter((i) => !i.todo?.doneAt)
  const done = all
    .filter((i) => i.todo?.doneAt)
    .sort((a, b) => Date.parse(b.todo!.doneAt!) - Date.parse(a.todo!.doneAt!))

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader partition="todo" count={open.length} />
      <AddTodo />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <EmptyState icon={ListTodoIcon} title="没有待办" hint="在 QQ 里发「周五前续费域名」，会自动识别为待办" />
      ) : (
        <LayoutGroup>
          {GROUPS.map((g) => {
            const items = open.filter((i) => groupOf(i) === g.key)
            if (items.length === 0) return null
            return (
              <motion.section layout key={g.key} className="rounded-2xl border bg-card p-3 shadow-xs">
                <h2 className={cn('px-2 pb-1 text-xs font-semibold', g.tone)}>
                  {g.label} <span className="font-normal text-muted-foreground">{items.length}</span>
                </h2>
                <AnimatePresence initial={false}>
                  {items.map((i) => (
                    <TodoRow key={i.id} item={i} />
                  ))}
                </AnimatePresence>
              </motion.section>
            )
          })}

          {open.length === 0 && <EmptyState icon={CircleCheckIcon} title="全部完成了" hint="休息一下吧" />}

          {done.length > 0 && (
            <motion.section layout className="rounded-2xl border border-dashed p-3">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="flex w-full items-center gap-1 px-2 pb-1 text-xs font-semibold text-muted-foreground"
              >
                <ChevronDownIcon className={cn('size-3.5 transition-transform', !showDone && '-rotate-90')} />
                已完成 <span className="font-normal">{done.length}</span>
              </button>
              <AnimatePresence initial={false}>
                {showDone && done.map((i) => <TodoRow key={i.id} item={i} />)}
              </AnimatePresence>
            </motion.section>
          )}
        </LayoutGroup>
      )}
    </div>
  )
}

function AddTodo() {
  const [title, setTitle] = useState('')
  const add = useAddTodo()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const t = title.trim()
    if (!t) return
    add.mutate(t, { onSuccess: () => setTitle('') })
  }
  return (
    <form onSubmit={submit} className="flex gap-2">
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="添加待办，回车保存"
        className="h-10"
      />
      <Button type="submit" size="lg" className="h-10" disabled={!title.trim() || add.isPending}>
        <PlusIcon />
        添加
      </Button>
    </form>
  )
}
