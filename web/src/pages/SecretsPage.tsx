import { useQueryClient } from '@tanstack/react-query'
import {
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FileLockIcon,
  KeyRoundIcon,
  LockIcon,
  LockOpenIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ScanEyeIcon,
  SparklesIcon,
  Trash2Icon,
  UndoIcon,
  UserRoundCogIcon,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { qk, useSecrets, useVaultState } from '@/api/hooks'
import type { Secret } from '@/api/types'
import { EmptyState, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { fileSize, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { VaultKeys } from '@/lib/vault-crypto'
import { errorText, type VaultCrypto } from './secrets/crypto'
import { AddSecretDialog, ChangePasswordDialog, FilePreviewDialog, type DecryptedFile } from './secrets/SecretDialogs'
import { RecoveryCodeCard, UnlockPanel, VaultSetup } from './secrets/VaultForms'

const IDLE_LOCK_MS = 5 * 60_000

interface Unlocked {
  keys: VaultKeys
  crypto: VaultCrypto
}

export function SecretsPage() {
  const qc = useQueryClient()
  const vault = useVaultState()
  const { data, isLoading } = useSecrets()
  const secrets = useMemo(() => data ?? [], [data])

  // 私钥与解密结果只放在内存里，锁定或离开页面即清除
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null)
  const [recoveryCode, setRecoveryCode] = useState<{ code: string; renewed: boolean } | null>(null)
  const [dialog, setDialog] = useState<'add' | 'password' | null>(null)
  const [preview, setPreview] = useState<DecryptedFile | null>(null)
  const [remaining, setRemaining] = useState(IDLE_LOCK_MS)
  const lastActive = useRef(0)

  const closePreview = useCallback(() => {
    setPreview((p) => {
      if (p) URL.revokeObjectURL(p.url)
      return null
    })
  }, [])

  const lock = useCallback(() => {
    setUnlocked((u) => {
      u?.crypto.forget(u.keys)
      return null
    })
    setDialog(null)
    closePreview()
  }, [closePreview])

  // 离开页面时锁定
  useEffect(() => lock, [lock])

  // 空闲 5 分钟或页面切到后台时自动锁定
  useEffect(() => {
    if (!unlocked) return
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
  }, [unlocked, lock])

  const plain = useMemo(() => {
    if (!unlocked) return null
    const out: Record<string, string> = {}
    for (const s of secrets) {
      if (!s.sealed) continue
      try {
        out[s.id] = unlocked.crypto.openText(s.sealed, unlocked.keys)
      } catch {
        out[s.id] = '（无法解密）'
      }
    }
    return out
  }, [secrets, unlocked])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.secrets })
    qc.invalidateQueries({ queryKey: qk.counts })
    qc.invalidateQueries({ queryKey: qk.timeline })
  }

  const openFile = async (secret: Secret) => {
    if (!unlocked) return
    try {
      const data = unlocked.crypto.openBytes(await api.secretBlob(secret.id), unlocked.keys)
      const mime = secret.mime || 'application/octet-stream'
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }))
      setPreview({ url, mime, name: secret.originalName || secret.label })
    } catch (err) {
      toast.error(errorText(err, '解密失败'))
    }
  }

  const remove = async (secret: Secret) => {
    if (!window.confirm(`删除「${secret.label}」？删除后进入回收站，不再显示`)) return
    try {
      await api.deleteSecret(secret.id)
      toast.success('已删除')
      refresh()
    } catch (err) {
      toast.error(errorText(err, '删除失败'))
    }
  }

  const release = async (secret: Secret) => {
    const text = plain?.[secret.id]
    if (!text) return
    if (!window.confirm(`把「${secret.label}」移出密钥库？内容会以明文作为普通条目保存，并交给 AI 整理`)) return
    try {
      await api.releaseSecret(secret.id, text)
      toast.success('已移出，作为普通条目重新整理')
      refresh()
      qc.invalidateQueries({ queryKey: ['items'] })
    } catch (err) {
      toast.error(errorText(err, '移出失败'))
    }
  }

  if (recoveryCode) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader partition="secret" />
        <RecoveryCodeCard
          code={recoveryCode.code}
          renewed={recoveryCode.renewed}
          onDone={() => {
            setRecoveryCode(null)
            qc.invalidateQueries({ queryKey: qk.vault })
            refresh()
          }}
        />
      </div>
    )
  }

  if (vault.isLoading || !vault.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader partition="secret" />
        <Skeleton className="h-56 rounded-2xl" />
      </div>
    )
  }

  if (!vault.data.initialized) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <PageHeader partition="secret" count={0} />
        <VaultSetup onCreated={(code) => setRecoveryCode({ code, renewed: false })} />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader partition="secret" count={secrets.length} />

      <AnimatePresence mode="wait" initial={false}>
        {unlocked ? (
          <motion.div
            key="unlocked"
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm"
          >
            <LockOpenIcon className="size-4 text-emerald-600" />
            <span className="flex-1">
              已解锁 · <span className="tabular-nums">{formatLeft(remaining)}</span> 后自动锁定
            </span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setDialog('add')}>
                <PlusIcon />
                添加
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog('password')}>
                <UserRoundCogIcon />
                改二级密码
              </Button>
              <Button size="sm" variant="outline" onClick={lock}>
                <LockIcon />
                锁定
              </Button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="locked" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <UnlockPanel
              onUnlocked={(keys, crypto) => setUnlocked({ keys, crypto })}
              onRecovered={(keys, crypto, code) => {
                setUnlocked({ keys, crypto })
                setRecoveryCode({ code, renewed: true })
              }}
            />
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
        <EmptyState icon={KeyRoundIcon} title="密钥库是空的" hint="在 QQ 里发送「#key 名称」，换行后写内容，会加密存到这里" />
      ) : (
        <div className="surface divide-y rounded-2xl">
          {secrets.map((s) => (
            <SecretRow
              key={s.id}
              secret={s}
              value={plain?.[s.id]}
              unlocked={Boolean(unlocked)}
              onOpenFile={() => openFile(s)}
              onRelease={() => release(s)}
              onDelete={() => remove(s)}
            />
          ))}
        </div>
      )}

      {unlocked && (
        <>
          <AddSecretDialog
            open={dialog === 'add'}
            onOpenChange={(open) => setDialog(open ? 'add' : null)}
            keys={unlocked.keys}
            crypto={unlocked.crypto}
            onAdded={refresh}
          />
          <ChangePasswordDialog
            open={dialog === 'password'}
            onOpenChange={(open) => setDialog(open ? 'password' : null)}
            keys={unlocked.keys}
            crypto={unlocked.crypto}
          />
        </>
      )}
      <FilePreviewDialog file={preview} onClose={closePreview} />
    </div>
  )
}

function SecretRow({
  secret,
  value,
  unlocked,
  onOpenFile,
  onRelease,
  onDelete,
}: {
  secret: Secret
  value?: string
  unlocked: boolean
  onOpenFile: () => void
  onRelease: () => void
  onDelete: () => void
}) {
  const [reveal, setReveal] = useState(false)
  const isFile = secret.kind === 'file'
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
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
        {isFile ? <FileLockIcon className="size-4" /> : <KeyRoundIcon className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium">
          <span className="truncate">{secret.label}</span>
          <span className="shrink-0 font-mono text-[11px] font-normal text-muted-foreground">#{secret.code}</span>
          {secret.detected && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-700 dark:text-amber-400"
              title={`自动识别：${secret.detected}`}
            >
              <SparklesIcon className="size-2.5" />
              自动识别
            </span>
          )}
        </p>
        {isFile ? (
          <p className="truncate text-xs text-muted-foreground">
            {[secret.originalName, secret.size ? fileSize(secret.size) : null].filter(Boolean).join(' · ') || '加密附件'}
          </p>
        ) : (
          <p
            className={cn(
              'font-mono text-xs',
              shown ? 'break-all whitespace-pre-wrap text-foreground' : 'truncate text-muted-foreground',
            )}
          >
            {shown ? value : '••••••••••••••••'}
          </p>
        )}
      </div>
      <span className="mt-1 hidden shrink-0 text-xs text-muted-foreground sm:block">{relativeTime(secret.createdAt)}</span>
      <div className="flex shrink-0 gap-1">
        {isFile ? (
          <Button variant="ghost" size="icon-sm" disabled={!unlocked} onClick={onOpenFile} aria-label="解密查看">
            <ScanEyeIcon />
          </Button>
        ) : (
          <>
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
          </>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="更多操作">
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {!isFile && (
              <DropdownMenuItem disabled={!unlocked} onSelect={onRelease}>
                <UndoIcon />
                不是密钥，移出
              </DropdownMenuItem>
            )}
            {!isFile && <DropdownMenuSeparator />}
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2Icon />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
