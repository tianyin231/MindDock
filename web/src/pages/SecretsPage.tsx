import { CopyIcon, EyeIcon, EyeOffIcon, KeyRoundIcon, LockIcon, LockOpenIcon, ShieldCheckIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api, isDemo } from '@/api/client'
import { useSecrets } from '@/api/hooks'
import type { Secret } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const IDLE_LOCK_MS = 5 * 60_000

export function SecretsPage() {
  const { data, isLoading } = useSecrets()
  // 解密结果只放在内存里，锁定或离开页面即丢弃
  const [plain, setPlain] = useState<Record<string, string> | null>(null)
  const [remaining, setRemaining] = useState(IDLE_LOCK_MS)
  const lastActive = useRef(0)

  const lock = useCallback(() => setPlain(null), [])

  // 空闲 5 分钟或页面切到后台时自动锁定
  useEffect(() => {
    if (!plain) return
    lastActive.current = Date.now()
    const touch = () => {
      lastActive.current = Date.now()
    }
    const onHidden = () => document.visibilityState === 'hidden' && lock()
    const tick = setInterval(() => {
      const left = IDLE_LOCK_MS - (Date.now() - lastActive.current)
      if (left <= 0) lock()
      else setRemaining(left)
    }, 1000)
    window.addEventListener('pointerdown', touch)
    window.addEventListener('keydown', touch)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      clearInterval(tick)
      window.removeEventListener('pointerdown', touch)
      window.removeEventListener('keydown', touch)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [plain, lock])

  const secrets = data ?? []

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader partition="secret" count={data?.length} />

      <AnimatePresence mode="wait" initial={false}>
        {plain ? (
          <motion.div
            key="unlocked"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm"
          >
            <LockOpenIcon className="size-4 text-emerald-600" />
            <span className="flex-1">
              已解锁 · <span className="tabular-nums">{formatLeft(remaining)}</span> 后自动锁定
            </span>
            <Button size="sm" variant="outline" onClick={lock}>
              <LockIcon />
              立即锁定
            </Button>
          </motion.div>
        ) : (
          <motion.div key="locked" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <UnlockForm onUnlocked={setPlain} />
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : secrets.length === 0 ? (
        <EmptyState icon={KeyRoundIcon} title="密钥库是空的" hint="在 QQ 里发送「#key 名称」加换行和内容，会加密存到这里" />
      ) : (
        <div className="divide-y rounded-2xl border bg-card shadow-xs">
          {secrets.map((s) => (
            <SecretRow key={s.id} secret={s} value={plain?.[s.id]} unlocked={Boolean(plain)} />
          ))}
        </div>
      )}
    </div>
  )
}

function UnlockForm({ onUnlocked }: { onUnlocked: (plain: Record<string, string>) => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onUnlocked(await api.unlockVault(password))
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '解锁失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="flex flex-col items-center gap-3 bg-gradient-to-b from-indigo-500/10 to-transparent px-6 pt-8 pb-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
          <LockIcon className="size-6" />
        </span>
        <div>
          <p className="font-semibold">密钥库已锁定</p>
          <p className="mt-1 text-sm text-muted-foreground">输入二级密码后在浏览器内解密，服务器上只有密文</p>
        </div>
        <div className="flex w-full max-w-sm gap-2">
          <Input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="二级密码"
            className="h-10"
            aria-invalid={Boolean(error)}
          />
          <Button type="submit" size="lg" className="h-10" disabled={busy}>
            {busy ? '解密中…' : '解锁'}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheckIcon className="size-3.5" />
          {isDemo ? '演示模式：输入任意内容即可解锁' : '空闲 5 分钟或切到后台会自动重新锁定'}
        </p>
      </div>
    </form>
  )
}

function SecretRow({ secret, value, unlocked }: { secret: Secret; value?: string; unlocked: boolean }) {
  const [reveal, setReveal] = useState(false)
  const shown = unlocked && reveal && value

  const copy = async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      toast.success('已复制，请尽快粘贴使用')
    } catch {
      toast.error('复制失败，请手动选择')
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
        <KeyRoundIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{secret.label}</span>
          <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">#{secret.code}</span>
        </p>
        <p className={cn('truncate font-mono text-xs', shown ? 'text-foreground' : 'text-muted-foreground')}>
          {shown ? value : '••••••••••••••••'}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{relativeTime(secret.createdAt)}</span>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!unlocked}
          onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? '隐藏' : '显示'}
        >
          {reveal && unlocked ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={!unlocked} onClick={copy} aria-label="复制">
          <CopyIcon />
        </Button>
      </div>
    </div>
  )
}

function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
