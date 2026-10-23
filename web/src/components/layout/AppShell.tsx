import {
  AlarmClockIcon,
  BookmarkIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Outlet, useNavigate, useSearchParams } from 'react-router'
import { isDemo } from '@/api/client'
import { useCounts } from '@/api/hooks'
import { useQQ } from '@/api/qq'
import { useSettings } from '@/api/settings'
import { AnimatedCount, Logo } from '@/components/common'
import { ItemSheet } from '@/components/ItemSheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { PARTITIONS } from '@/lib/partitions'
import { useTheme, type Theme } from '@/lib/theme-context'
import { cn } from '@/lib/utils'

export function AppShell() {
  return (
    <div className="min-h-svh bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-sidebar lg:block">
        <SidebarContent />
      </aside>
      <div className="lg:pl-64">
        <TopBar />
        <main className="mx-auto max-w-7xl px-4 pt-5 pb-28 sm:px-6 lg:px-8 lg:pb-12">
          <Outlet />
        </main>
      </div>
      <MobileTabBar />
      <ItemSheet />
    </div>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { data: counts } = useCounts()
  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-2 pt-1">
        <Logo className="size-9" />
        <span>
          <span className="block font-semibold tracking-tight">MindDock</span>
          <span className="block text-xs text-muted-foreground">随身 · 安全 · 有序</span>
        </span>
      </Link>

      <nav className="flex flex-col gap-0.5">
        <SideLink to="/" end icon={LayoutDashboardIcon} label="总览" onNavigate={onNavigate} />
        <p className="mt-5 mb-1.5 px-3 text-xs font-medium text-muted-foreground">分区</p>
        {PARTITIONS.map((p) => (
          <SideLink
            key={p.key}
            to={p.path}
            icon={p.icon}
            label={p.label}
            iconClassName={cn(p.soft, p.text)}
            count={counts?.[p.key]}
            onNavigate={onNavigate}
          />
        ))}
        <div className="my-3 border-t" />
        <SideLink to="/settings" icon={SettingsIcon} label="设置" onNavigate={onNavigate} />
      </nav>

      <StatusPanel onNavigate={onNavigate} />
    </div>
  )
}

function SideLink({
  to,
  end,
  icon: Icon,
  label,
  count,
  iconClassName,
  onNavigate,
}: {
  to: string
  end?: boolean
  icon: LucideIcon
  label: string
  count?: number
  iconClassName?: string
  onNavigate?: () => void
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm transition-colors',
          isActive
            ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
        )
      }
    >
      <span className={cn('flex size-7 items-center justify-center rounded-md', iconClassName ?? 'bg-muted')}>
        <Icon className="size-4" />
      </span>
      <span className="flex-1">{label}</span>
      {count !== undefined && <AnimatedCount value={count} className="text-xs text-muted-foreground" />}
    </NavLink>
  )
}

function StatusPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { data: sections } = useSettings()
  const { data: qq } = useQQ()
  const configured = (key: string) => sections?.find((s) => s.key === key)?.configured

  const qqText = !qq
    ? '…'
    : qq.status.online
      ? qq.owner.bound
        ? '在线'
        : '在线 · 未绑定'
      : qq.configured
        ? '离线'
        : '未配置'
  const rows = [
    { label: 'QQ 机器人', ok: Boolean(qq?.status.online && qq.owner.bound), text: qqText },
    ...[
      { key: 'ai', label: 'AI 模型' },
      { key: 'storage', label: '夸克网盘' },
    ].map((r) => {
      const c = configured(r.key)
      return { label: r.label, ok: Boolean(c), text: c === undefined ? '…' : c ? '已配置' : '未配置' }
    }),
  ]

  return (
    <Link
      to="/settings"
      onClick={onNavigate}
      className="mt-auto block space-y-2 rounded-xl border bg-background/60 p-3 text-xs transition-colors hover:bg-background"
    >
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between">
          <span className="text-muted-foreground">{r.label}</span>
          <span className="flex items-center gap-1.5">
            <span className={cn('size-1.5 rounded-full', r.ok ? 'bg-emerald-500' : 'bg-amber-500')} />
            {r.text}
          </span>
        </div>
      ))}
      {isDemo && <p className="border-t pt-2 text-[11px] text-muted-foreground">演示模式：使用内存中的示例数据</p>}
    </Link>
  )
}

function TopBar() {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6 lg:px-8">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="打开导航">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 bg-sidebar p-0" showCloseButton={false}>
            <SheetTitle className="sr-only">导航</SheetTitle>
            <SidebarContent onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Sheet>
        <Link to="/" className="flex items-center gap-2 lg:hidden">
          <Logo className="size-7" />
          <span className="font-semibold tracking-tight">MindDock</span>
        </Link>

        <SearchBox />

        <div className="ml-auto flex items-center gap-1.5">
          {isDemo && (
            <Badge variant="secondary" className="hidden sm:inline-flex">
              演示数据
            </Badge>
          )}
          <Button variant="ghost" size="icon" className="sm:hidden" asChild>
            <Link to="/search" aria-label="搜索">
              <SearchIcon />
            </Link>
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}

function SearchBox() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [value, setValue] = useState(params.get('q') ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  // 按 / 聚焦搜索框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(target.tagName) && !target.isContentEditable) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const q = value.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <form onSubmit={submit} className="relative hidden w-full max-w-sm sm:block">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="搜索全部内容"
        className="h-9 bg-muted/50 pr-8 pl-8"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border bg-background px-1.5 text-[10px] text-muted-foreground">
        /
      </kbd>
    </form>
  )
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="切换主题">
          <SunIcon className="scale-100 rotate-0 transition-transform dark:scale-0 dark:-rotate-90" />
          <MoonIcon className="absolute scale-0 rotate-90 transition-transform dark:scale-100 dark:rotate-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
          <DropdownMenuRadioItem value="light">
            <SunIcon />
            浅色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <MoonIcon />
            深色
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">
            <MonitorIcon />
            跟随系统
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const TABS: { to: string; label: string; icon: LucideIcon; end?: boolean }[] = [
  { to: '/', label: '总览', icon: LayoutDashboardIcon, end: true },
  { to: '/todos', label: '待办', icon: ListTodoIcon },
  { to: '/reminders', label: '提醒', icon: AlarmClockIcon },
  { to: '/bookmarks', label: '收藏', icon: BookmarkIcon },
  { to: '/search', label: '搜索', icon: SearchIcon },
]

function MobileTabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
      <div className="mx-auto grid max-w-md grid-cols-5">
        {TABS.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors',
                isActive ? 'text-foreground' : 'text-muted-foreground',
              )
            }
          >
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
