import {
  AlarmClockIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  RadioTowerIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  type LucideIcon,
} from 'lucide-react'
import { LayoutGroup, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate, useOutlet, useSearchParams } from 'react-router'
import { isDemo } from '@/api/client'
import { useCounts } from '@/api/hooks'
import { useQQ } from '@/api/qq'
import { useSettings } from '@/api/settings'
import type { PartitionKey } from '@/api/types'
import { AnimatedCount, Logo } from '@/components/common'
import { StorageBanner } from '@/components/layout/StorageBanner'
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
import { LandingPulse } from '@/live/LandingPulse'
import { ORIGIN, useFlightSource, useFlightTarget } from '@/live/live'
import { PARTITIONS } from '@/lib/partitions'
import { useTheme, type Theme } from '@/lib/theme-context'
import { cn } from '@/lib/utils'

export function AppShell() {
  return (
    <div className="min-h-svh">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-sidebar backdrop-blur-xl lg:block">
        <SidebarContent />
      </aside>
      <div className="lg:pl-64">
        <TopBar />
        <main className="mx-auto max-w-7xl px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pb-14">
          <StorageBanner />
          <PageTransition />
        </main>
      </div>
      <MobileTabBar />
      <ItemSheet />
    </div>
  )
}

/** 切换页面时内容轻轻浮上来；只按路径区分，打开条目详情（改的是查询参数）不会触发 */
function PageTransition() {
  const { pathname } = useLocation()
  const outlet = useOutlet()
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
    >
      {outlet}
    </motion.div>
  )
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { data: counts } = useCounts()
  return (
    // 桌面侧栏和手机抽屉各自一组，避免两处的选中指示块互相"飞"
    <LayoutGroup id={onNavigate ? 'sheet-nav' : 'side-nav'}>
      <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-3 px-2 pt-1">
          <Logo className="size-9 drop-shadow-[0_4px_12px_oklch(0.56_0.21_285/0.35)]" />
          <span>
            <span className="block font-semibold tracking-tight">MindDock</span>
            <span className="block text-xs text-muted-foreground">随身 · 安全 · 有序</span>
          </span>
        </Link>

        <nav className="flex flex-col gap-0.5">
          <SideLink to="/" end icon={LayoutDashboardIcon} label="总览" onNavigate={onNavigate} />
          <SideLink to="/stream" icon={RadioTowerIcon} label="收件台" onNavigate={onNavigate} trailing={<LiveDot />} />
          <p className="eyebrow mt-5 mb-1.5 px-3">分区</p>
          {PARTITIONS.map((p) => (
            <SideLink
              key={p.key}
              to={p.path}
              icon={p.icon}
              label={p.label}
              partition={p.key}
              iconClassName={cn(p.soft, p.text)}
              trailing={
                counts?.[p.key] !== undefined && (
                  <AnimatedCount value={counts[p.key]} className="font-mono text-xs text-muted-foreground" />
                )
              }
              onNavigate={onNavigate}
            />
          ))}
          <div className="my-3 border-t" />
          <SideLink to="/settings" icon={SettingsIcon} label="设置" onNavigate={onNavigate} />
        </nav>

        <StatusPanel onNavigate={onNavigate} />
      </div>
    </LayoutGroup>
  )
}

function LiveDot() {
  return (
    <span className="relative flex size-1.5">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
      <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
    </span>
  )
}

function SideLink({
  to,
  end,
  icon: Icon,
  label,
  partition,
  trailing,
  iconClassName,
  onNavigate,
}: {
  to: string
  end?: boolean
  icon: LucideIcon
  label: string
  partition?: PartitionKey
  trailing?: ReactNode
  iconClassName?: string
  onNavigate?: () => void
}) {
  // 分区入口也是归类动画的落点（优先级最低：页面上有更醒目的落点时不会飞到这里）
  const targetRef = useFlightTarget(partition, 1)
  return (
    <NavLink
      ref={targetRef}
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-3 rounded-xl px-2 py-1.5 text-sm transition-colors',
          isActive ? 'font-medium text-sidebar-accent-foreground' : 'text-muted-foreground hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="nav-active"
              className="absolute inset-0 rounded-xl bg-sidebar-accent shadow-[var(--surface-highlight),0_1px_2px_oklch(0_0_0/0.06)] ring-1 ring-sidebar-border"
              transition={{ type: 'spring', stiffness: 420, damping: 36 }}
            />
          )}
          {partition && <LandingPulse partition={partition} />}
          <span className={cn('relative flex size-7 items-center justify-center rounded-lg', iconClassName ?? 'bg-muted')}>
            <Icon className="size-4" />
          </span>
          <span className="relative flex-1">{label}</span>
          {trailing && <span className="relative flex items-center">{trailing}</span>}
        </>
      )}
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
      className="surface mt-auto block space-y-2 rounded-2xl p-3 text-xs transition-shadow hover:surface-lift"
    >
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between">
          <span className="text-muted-foreground">{r.label}</span>
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                'size-1.5 rounded-full',
                r.ok ? 'bg-emerald-500 shadow-[0_0_6px_var(--color-emerald-500)]' : 'bg-amber-500',
              )}
            />
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
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6 lg:px-8">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="打开导航">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 bg-sidebar p-0 backdrop-blur-xl" showCloseButton={false}>
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
          <StreamButton />
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

/** 顶栏的收件台入口：任何页面上新内容归类后，都从这里飞向侧栏对应的分区 */
function StreamButton() {
  const originRef = useFlightSource(ORIGIN, 1)
  return (
    <Link
      to="/stream"
      className="hidden h-8 items-center gap-2 rounded-full border bg-card/70 pr-3 pl-2.5 text-xs font-medium text-muted-foreground shadow-xs transition-colors hover:text-foreground sm:flex"
    >
      <span ref={originRef}>
        <LiveDot />
      </span>
      收件台
    </Link>
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
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="搜索全部内容"
        className="h-9 rounded-full border-border/80 bg-card/60 pr-9 pl-9 shadow-xs"
      />
      <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground">
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
  { to: '/stream', label: '收件台', icon: RadioTowerIcon },
  { to: '/todos', label: '待办', icon: ListTodoIcon },
  { to: '/reminders', label: '提醒', icon: AlarmClockIcon },
  { to: '/search', label: '搜索', icon: SearchIcon },
]

function MobileTabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <LayoutGroup id="tab-bar">
        <div className="mx-auto grid max-w-md grid-cols-5 px-2">
          {TABS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'relative flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors',
                  isActive ? 'font-medium text-foreground' : 'text-muted-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="tab-active"
                      className="absolute top-0 h-0.5 w-8 rounded-full bg-foreground"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  <Icon className="size-5" />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </LayoutGroup>
    </nav>
  )
}
