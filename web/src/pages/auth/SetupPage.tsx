import { useQueryClient } from '@tanstack/react-query'
import { CopyIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate } from 'react-router'
import { toast } from 'sonner'
import { ApiError } from '@/api/http'
import { authApi, authKey, useAuthState, type SetupStarted } from '@/auth/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout, FormError } from './AuthLayout'

const MIN_PASSWORD = 10

export function SetupPage() {
  const { data } = useAuthState()
  const qc = useQueryClient()

  const [setupCode, setSetupCode] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [started, setStarted] = useState<SetupStarted | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [finished, setFinished] = useState(false)

  // 登录状态刷新后由这里统一跳转：刚完成初始化去设置页，否则回首页
  if (data && !data.setup_required) return <Navigate to={finished ? '/settings' : '/'} replace />

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const submitAccount = (e: FormEvent) => {
    e.preventDefault()
    if (password.length < MIN_PASSWORD) return setError(`密码至少 ${MIN_PASSWORD} 位`)
    if (password !== confirm) return setError('两次输入的密码不一致')
    run(async () => setStarted(await authApi.setupStart(setupCode, username, password)))
  }

  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await authApi.setupFinish(started!.setup_token, code)
      setFinished(true)
      toast.success('账号已创建，先来配置 QQ 机器人和 AI 模型吧')
      await qc.invalidateQueries({ queryKey: authKey })
    })
  }

  if (started) {
    const grouped = started.totp_secret.match(/.{1,4}/g)?.join(' ') ?? started.totp_secret
    return (
      <AuthLayout title="绑定验证器" subtitle="第 2 步，共 2 步：新设备登录时需要验证码">
        <form onSubmit={submitCode} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            用手机上的验证器 App（如 Microsoft Authenticator、Google Authenticator）扫描二维码：
          </p>
          <img
            src={started.totp_qr}
            alt="验证器二维码"
            className="mx-auto size-48 rounded-lg bg-white p-2"
          />
          <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2">
            <code className="flex-1 font-mono text-xs break-all">{grouped}</code>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="复制密钥"
              onClick={() => navigator.clipboard?.writeText(started.totp_secret).then(() => toast.success('已复制'))}
            >
              <CopyIcon />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">无法扫码时，可在验证器里手动输入上面这串密钥。也建议把它存进 KeePassXC。</p>
          <div className="space-y-2">
            <Label htmlFor="code">验证器显示的 6 位数字</Label>
            <Input
              id="code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-11 text-center font-mono text-lg tracking-[0.4em]"
            />
          </div>
          <FormError message={error} />
          <Button type="submit" size="lg" className="h-10 w-full" disabled={busy || code.trim().length < 6}>
            {busy ? '验证中…' : '完成初始化'}
          </Button>
        </form>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="初始化 MindDock" subtitle="第 1 步，共 2 步：创建你的账号">
      <form onSubmit={submitAccount} className="space-y-4" autoComplete="on">
        <div className="space-y-2">
          <Label htmlFor="setup-code">初始化码</Label>
          <Input
            id="setup-code"
            autoComplete="off"
            value={setupCode}
            onChange={(e) => setSetupCode(e.target.value)}
            placeholder="XXXX-XXXX"
            className="h-10 font-mono uppercase"
          />
          <p className="text-xs text-muted-foreground">打印在服务器日志里，只能用一次</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="new-password">密码</Label>
          <Input
            id="new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10"
          />
          <p className="text-xs text-muted-foreground">至少 {MIN_PASSWORD} 位。浏览器会提示保存，之后自动填充</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">再输入一次</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="h-10"
          />
        </div>
        <FormError message={error} />
        <Button
          type="submit"
          size="lg"
          className="h-10 w-full"
          disabled={busy || !setupCode || !username || !password || !confirm}
        >
          {busy ? '提交中…' : '下一步'}
        </Button>
      </form>
    </AuthLayout>
  )
}
