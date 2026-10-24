import { CheckIcon, CopyIcon, KeyRoundIcon, LifeBuoyIcon, LockIcon, ShieldCheckIcon } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, isDemo } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { VaultKeys } from '@/lib/vault-crypto'
import { errorText, isWrongSecret, loadCrypto, nextFrame, type VaultCrypto } from './crypto'
import { SecretInput } from './SecretInput'

function Panel({ icon, title, hint, children }: { icon: ReactNode; title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="flex flex-col items-center gap-3 bg-gradient-to-b from-indigo-500/10 to-transparent px-6 pt-8 pb-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
          {icon}
        </span>
        <div>
          <p className="font-semibold">{title}</p>
          <div className="mt-1 text-sm text-muted-foreground">{hint}</div>
        </div>
        {children}
      </div>
    </div>
  )
}

function checkNewPassword(password: string, confirm: string): string {
  if (!password) return '请输入二级密码'
  if (password !== confirm) return '两次输入的二级密码不一致'
  return ''
}

// ---- 启用 ----

export function VaultSetup({ onCreated }: { onCreated: (recoveryCode: string) => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = checkNewPassword(password, confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await nextFrame()
      const crypto = await loadCrypto()
      const { body, recoveryCode } = crypto.createVault(password)
      await api.vaultSetup(body)
      setPassword('')
      setConfirm('')
      onCreated(recoveryCode)
    } catch (err) {
      setError(errorText(err, '启用失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      icon={<ShieldCheckIcon className="size-6" />}
      title="启用密钥库"
      hint="设置一个二级密码，之后 #key 发来的内容会加密保存在这里"
    >
      <ul className="max-w-md space-y-1.5 text-left text-xs text-muted-foreground">
        <li>· 密钥在入库时就用公钥加密，服务器上只有密文；只有输入二级密码，才能在你的浏览器里解开</li>
        <li>· 二级密码不会发送到服务器，浏览器也不会记住；建议和登录密码不同，存进密码管理器</li>
        <li>· 启用后会显示一次恢复码，忘记二级密码时用它重设；两者都丢失，密钥将无法找回</li>
      </ul>
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-2">
        <SecretInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="二级密码"
          aria-label="二级密码"
          aria-invalid={Boolean(error)}
        />
        <SecretInput
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="再输入一次"
          aria-label="确认二级密码"
          aria-invalid={Boolean(error)}
        />
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? '正在生成密钥…' : '启用密钥库'}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {isDemo && <p className="text-xs text-muted-foreground">演示模式：二级密码随意设置即可</p>}
      </form>
    </Panel>
  )
}

/** 恢复码只显示这一次 */
export function RecoveryCodeCard({ code, onDone, renewed = false }: { code: string; onDone: () => void; renewed?: boolean }) {
  const [saved, setSaved] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('已复制，请保存到密码管理器')
    } catch {
      toast.error('复制失败，请手动抄写')
    }
  }

  return (
    <Panel
      icon={<LifeBuoyIcon className="size-6" />}
      title={renewed ? '这是新的恢复码' : '请保存恢复码'}
      hint={
        renewed
          ? '旧的恢复码已经作废。新的恢复码只显示这一次'
          : '忘记二级密码时，用它重设。恢复码只显示这一次，关闭后无法再查看'
      }
    >
      <div
        className="grid w-full max-w-sm grid-cols-4 gap-x-3 gap-y-1 rounded-xl border bg-background px-4 py-3 font-mono text-base font-semibold tracking-wider select-all"
        aria-label="恢复码"
      >
        {code.split('-').map((group, i) => (
          <span key={i}>
            {group}
            {/* 复制或选中时保留横线 */}
            {i < 7 && <span className="sr-only">-</span>}
          </span>
        ))}
      </div>
      <Button type="button" variant="outline" onClick={copy}>
        <CopyIcon />
        复制恢复码
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} />
        我已把恢复码保存到安全的地方
      </label>
      <Button type="button" size="lg" disabled={!saved} onClick={onDone}>
        <CheckIcon />
        完成
      </Button>
    </Panel>
  )
}

// ---- 解锁与恢复 ----

async function unlockWith(
  pick: 'password' | 'recovery',
  secret: string,
): Promise<{ keys: VaultKeys; crypto: VaultCrypto }> {
  await nextFrame()
  const crypto = await loadCrypto()
  const material = await api.vaultKeys()
  const privateKey = crypto.unwrapKey(material[pick], secret)
  return { keys: { publicKey: crypto.fromB64(material.publicKey), privateKey }, crypto }
}

export function UnlockPanel({
  onUnlocked,
  onRecovered,
}: {
  onUnlocked: (keys: VaultKeys, crypto: VaultCrypto) => void
  onRecovered: (keys: VaultKeys, crypto: VaultCrypto, newRecoveryCode: string) => void
}) {
  const [mode, setMode] = useState<'password' | 'recover'>('password')
  return mode === 'password' ? (
    <PasswordUnlock onUnlocked={onUnlocked} onForgot={() => setMode('recover')} />
  ) : (
    <RecoverForm onRecovered={onRecovered} onCancel={() => setMode('password')} />
  )
}

function PasswordUnlock({
  onUnlocked,
  onForgot,
}: {
  onUnlocked: (keys: VaultKeys, crypto: VaultCrypto) => void
  onForgot: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    setError('')
    try {
      const { keys, crypto } = await unlockWith('password', password)
      setPassword('')
      onUnlocked(keys, crypto)
    } catch (err) {
      setError(isWrongSecret(err) ? '二级密码不正确' : errorText(err, '解锁失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      icon={<LockIcon className="size-6" />}
      title="密钥库已锁定"
      hint="输入二级密码后在浏览器内解密，服务器上只有密文"
    >
      <form onSubmit={submit} className="flex w-full max-w-sm gap-2">
        <SecretInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="二级密码"
          aria-label="二级密码"
          aria-invalid={Boolean(error)}
          autoFocus
        />
        <Button type="submit" size="lg" className="h-10" disabled={busy || !password}>
          {busy ? '解密中…' : '解锁'}
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon className="size-3.5" />
        空闲 5 分钟或切到后台会自动重新锁定
      </p>
      <button type="button" onClick={onForgot} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        忘记二级密码？用恢复码重设
      </button>
    </Panel>
  )
}

function RecoverForm({
  onRecovered,
  onCancel,
}: {
  onRecovered: (keys: VaultKeys, crypto: VaultCrypto, newRecoveryCode: string) => void
  onCancel: () => void
}) {
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const problem = checkNewPassword(password, confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      const crypto = await loadCrypto()
      if (!crypto.looksLikeRecoveryCode(code)) throw new Error('恢复码格式不对，应为 8 组、每组 4 位')
      const { keys } = await unlockWith('recovery', crypto.normalizeRecoveryCode(code))
      // 恢复码用过一次就换新的
      const newCode = crypto.newRecoveryCode()
      const passwordWrap = crypto.wrapKey(keys.privateKey, password)
      const recoveryWrap = crypto.wrapKey(keys.privateKey, crypto.normalizeRecoveryCode(newCode))
      const challenge = await api.vaultChallenge()
      await api.vaultRewrap({
        token: challenge.token,
        answer: crypto.answerChallenge(challenge.sealed, keys),
        password: passwordWrap,
        recovery: recoveryWrap,
      })
      onRecovered(keys, crypto, newCode)
    } catch (err) {
      setError(isWrongSecret(err) ? '恢复码不正确' : errorText(err, '重设失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel icon={<KeyRoundIcon className="size-6" />} title="用恢复码重设二级密码" hint="重设后会生成新的恢复码，旧的随之作废">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-2">
        <SecretInput
          mask={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="恢复码，如 7K2Q-…"
          aria-label="恢复码"
          className="font-mono uppercase"
        />
        <SecretInput
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="新的二级密码"
          aria-label="新的二级密码"
        />
        <SecretInput
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="再输入一次"
          aria-label="确认新的二级密码"
        />
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? '正在重设…' : '重设二级密码'}
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </form>
      <button type="button" onClick={onCancel} className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        返回用二级密码解锁
      </button>
    </Panel>
  )
}
