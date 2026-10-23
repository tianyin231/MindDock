import { AlarmClockIcon, BookmarkIcon, ChevronRightIcon, CircleCheckIcon, FolderOpenIcon, ListTodoIcon, NotebookPenIcon } from 'lucide-react'
import { AnimatePresence, LayoutGroup } from 'motion/react'
import type { ComponentType, ReactNode } from 'react'
import { Link } from 'react-router'
import { useItems } from '@/api/hooks'
import { EmptyState } from '@/components/common'
import { BookmarkCard, FileTile, NoteCard, ReminderRow, TodoRow } from '@/components/items'
import { Skeleton } from '@/components/ui/skeleton'
import { dayDiff, fullDate, greeting } from '@/lib/format'
import { cn } from '@/lib/utils'
import { LiveInbox } from './LiveInbox'
import { PocketTiles } from './PocketTiles'

export function OverviewPage() {
  return (
    // 分区格子与收件流必须在同一个 LayoutGroup 里，卡片才能飞过去
    <LayoutGroup>
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{greeting()}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {fullDate()} · 发给 QQ 机器人的内容会自动归入下面的分区
          </p>
        </header>

        <PocketTiles />

        <div className="grid gap-6 lg:grid-cols-12">
          <LiveInbox className="lg:col-span-5" />
          <div className="grid content-start gap-6 sm:grid-cols-2 lg:col-span-7">
            <TodayTodos />
            <UpcomingReminders />
          </div>
        </div>

        <RecentBookmarks />

        <div className="grid gap-6 lg:grid-cols-2">
          <RecentNotes />
          <RecentFiles />
        </div>
      </div>
    </LayoutGroup>
  )
}

function Widget({
  title,
  icon: Icon,
  to,
  meta,
  children,
  className,
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  to: string
  meta?: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-2xl border bg-card p-4 shadow-xs', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-muted-foreground" />
          {title}
          {meta && <span className="text-xs font-normal text-muted-foreground">{meta}</span>}
        </h2>
        <Link to={to} className="flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground">
          全部
          <ChevronRightIcon className="size-3.5" />
        </Link>
      </div>
      {children}
    </section>
  )
}

function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 py-1">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}

function TodayTodos() {
  const { data, isLoading } = useItems('todo')
  const all = data ?? []
  // 今天到期 / 已逾期的未完成项，加上今天刚完成的（保留删除线，让勾选有反馈）
  const list = all.filter((i) =>
    i.todo?.doneAt ? dayDiff(i.todo.doneAt) === 0 : i.todo?.dueAt !== undefined && dayDiff(i.todo.dueAt) <= 0,
  )
  const open = all.filter((i) => !i.todo?.doneAt).length

  return (
    <Widget title="今日待办" icon={ListTodoIcon} to="/todos" meta={`${open} 项未完成`}>
      {isLoading ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <EmptyState icon={CircleCheckIcon} title="今天没有到期的待办" className="py-6" />
      ) : (
        <AnimatePresence initial={false}>
          {list.map((i) => (
            <TodoRow key={i.id} item={i} />
          ))}
        </AnimatePresence>
      )}
    </Widget>
  )
}

function UpcomingReminders() {
  const { data, isLoading } = useItems('reminder')
  const list = (data ?? []).filter((i) => i.reminder?.status === 'scheduled').slice(0, 4)
  return (
    <Widget title="即将提醒" icon={AlarmClockIcon} to="/reminders">
      {isLoading ? (
        <ListSkeleton />
      ) : list.length === 0 ? (
        <EmptyState icon={AlarmClockIcon} title="没有待发送的提醒" className="py-6" />
      ) : (
        list.map((i) => <ReminderRow key={i.id} item={i} />)
      )}
    </Widget>
  )
}

function RecentBookmarks() {
  const { data, isLoading } = useItems('bookmark')
  return (
    <section className="space-y-3">
      <SectionTitle title="最近收藏" icon={BookmarkIcon} to="/bookmarks" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {isLoading
          ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-44 rounded-xl" />)
          : (data ?? []).slice(0, 4).map((i) => <BookmarkCard key={i.id} item={i} />)}
      </div>
    </section>
  )
}

function RecentNotes() {
  const { data, isLoading } = useItems('note')
  return (
    <section className="space-y-3">
      <SectionTitle title="最近笔记" icon={NotebookPenIcon} to="/notes" />
      <div className="space-y-3">
        {isLoading ? <ListSkeleton /> : (data ?? []).slice(0, 3).map((i) => <NoteCard key={i.id} item={i} />)}
      </div>
    </section>
  )
}

function RecentFiles() {
  const { data, isLoading } = useItems('file')
  return (
    <section className="space-y-3">
      <SectionTitle title="最近文件" icon={FolderOpenIcon} to="/files" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {isLoading
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-xl" />)
          : (data ?? []).slice(0, 6).map((i) => <FileTile key={i.id} item={i} />)}
      </div>
    </section>
  )
}

function SectionTitle({ title, icon: Icon, to }: { title: string; icon: ComponentType<{ className?: string }>; to: string }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </h2>
      <Link to={to} className="flex items-center text-xs text-muted-foreground transition-colors hover:text-foreground">
        全部
        <ChevronRightIcon className="size-3.5" />
      </Link>
    </div>
  )
}
