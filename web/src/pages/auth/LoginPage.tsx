import { useQueryClient } from '@tanstack/react-query'
import { ShieldCheckIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useSearchParams } from 'react-router'
import { ApiError } from '@/api/http'
import { authApi, authKey, useAuthState } from '@/auth/auth'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AuthLayout, FormError } from './AuthLayout'

export function LoginPage() {
  const { data } = useAuthState()
  const [params] = useSearchParams()
  const qc = useQueryClient()

  const [step, setStep] = useState<'password' | 'totp'>('password')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const [trust, setTrust] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 只接受站内路径，防止 next 参数被用来跳到外部网站
  const next = params.get('next')
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'

  // 登录状态刷新后由这里统一跳转
  if (data?.setup_required) return <Navigate to="/setup" replace />
  if (data?.authenticated) return <Navigate to={target} replace />

  const done = () => qc.invalidateQueries({ queryKey: authKey })

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  const submitPassword = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      const result = await authApi.login(username, password)
      if (result.status === 'ok') return done()
      setChallenge(result.challenge)
      setStep('totp')
    })
  }

  const submitCode = (e: FormEvent) => {
    e.preventDefault()
    run(async () => {
      await authApi.loginTotp(challenge, code, trust)
      await done()
    })
  }

  if (step === 'totp') {
    return (
      <AuthLayout title="验证新设备" subtitle="这是你第一次在这个浏览器上登录">
        <form onSubmit={submitCode} className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg bg-muted/60 p-3 text-sm">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-indigo-600" />
            <span>打开手机上的验证器 App，输入 MindDock 的 6 位验证码</span>
          </div>
          <div className="space-y-2">
            <Label htmlFor="code">验证码</Label>
            <Input
              id="code"
              name="code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              className="h-11 text-center font-mono text-lg tracking-[0.4em]"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={trust} onCheckedChange={(v) => setTrust(v === true)} />
            信任此设备 30 天，期间只需密码
          </label>
          <FormError message={error} />
          <Button type="submit" size="lg" className="h-10 w-full" disabled={busy || code.trim().length < 6}>
            {busy ? '验证中…' : '验证并登录'}
          </Button>
          <button
            type="button"
            className="w-full text-center text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              setStep('password')
              setCode('')
              setError('')
            }}
          >
            返回重新输入密码
          </button>
        </form>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="登录 MindDock" subtitle="欢迎回来">
      {/* 标准登录表单：浏览器会提示保存密码，下次自动填充 */}
      <form onSubmit={submitPassword} className="space-y-4" autoComplete="on">
        <div className="space-y-2">
          <Label htmlFor="username">用户名</Label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="h-10"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">密码</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-10"
          />
        </div>
        <FormError message={error} />
        <Button type="submit" size="lg" className="h-10 w-full" disabled={busy || !username || !password}>
          {busy ? '登录中…' : '登录'}
        </Button>
      </form>
    </AuthLayout>
  )
}
