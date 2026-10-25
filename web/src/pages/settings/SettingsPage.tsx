import {
  BotIcon,
  CircleCheckIcon,
  CircleXIcon,
  CloudIcon,
  ExternalLinkIcon,
  InfoIcon,
  Loader2Icon,
  LogOutIcon,
  MailIcon,
  SettingsIcon,
  SparklesIcon,
  UserIcon,
  type LucideIcon,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/api/http'
import {
  useHealth,
  useSaveSection,
  useSettings,
  useTestSection,
  type SecretValue,
  type SettingField,
  type SettingSection,
  type TestResult,
} from '@/api/settings'
import { useAuthState, useLogout } from '@/auth/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BackupCard } from './BackupCard'
import { QQBinding } from './QQBinding'
import { StorageStatus } from './StorageStatus'

const SECTION_ICON: Record<string, LucideIcon> = {
  qq: BotIcon,
  ai: SparklesIcon,
  storage: CloudIcon,
  notify: MailIcon,
}

export function SettingsPage() {
  const { data: sections, isLoading } = useSettings()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl bg-muted">
          <SettingsIcon className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">设置</h1>
          <p className="text-sm text-muted-foreground">密钥类内容加密保存，保存后不再显示明文</p>
        </div>
      </div>

      {isLoading || !sections
        ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-56 rounded-2xl" />)
        : sections.map((s) => (
            <SectionCard
              key={s.key}
              section={s}
              extra={s.key === 'qq' ? <QQBinding /> : s.key === 'storage' ? <StorageStatus /> : null}
            />
          ))}

      <BackupCard />
      <AccountCard />
      <AboutCard />
    </div>
  )
}

type Draft = Record<string, string | boolean>

function initialDraft(section: SettingSection): Draft {
  const draft: Draft = {}
  for (const f of section.fields) {
    const v = section.values[f.key]
    if (f.kind === 'secret') draft[f.key] = ''
    else if (f.kind === 'bool') draft[f.key] = Boolean(v)
    else draft[f.key] = v === null || v === undefined ? '' : String(v)
  }
  return draft
}

function SectionCard({ section, extra }: { section: SettingSection; extra?: ReactNode }) {
  const Icon = SECTION_ICON[section.key] ?? SettingsIcon
  const base = useMemo(() => initialDraft(section), [section])
  const [draft, setDraft] = useState<Draft>(base)
  const [editingSecret, setEditingSecret] = useState<Record<string, boolean>>({})
  const [result, setResult] = useState<TestResult | null>(null)
  const save = useSaveSection(section.key)
  const test = useTestSection(section.key)

  // 只提交改动过的字段；密钥字段在首次填写或点"更换"后填写时才提交
  const changes = useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const f of section.fields) {
      const value = draft[f.key]
      if (f.kind === 'secret') {
        const alreadySet = (section.values[f.key] as SecretValue | undefined)?.set
        const editable = editingSecret[f.key] || !alreadySet
        if (editable && typeof value === 'string' && value.trim()) out[f.key] = value
      } else if (value !== base[f.key]) {
        out[f.key] = f.kind === 'number' ? (value === '' ? null : Number(value)) : value
      }
    }
    return out
  }, [base, draft, editingSecret, section.fields, section.values])
  const dirty = Object.keys(changes).length > 0

  const persist = async () => {
    const saved = await save.mutateAsync(changes)
    setDraft(initialDraft(saved))
    setEditingSecret({})
  }

  const onSave = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await persist()
      setResult(null)
      toast.success(`${section.title}已保存`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : '保存失败')
    }
  }

  const onTest = async () => {
    try {
      if (dirty) await persist()
      setResult(await test.mutateAsync())
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : '测试失败', details: {} })
    }
  }

  return (
    <form onSubmit={onSave} className="surface rounded-2xl" autoComplete="off">
      <div className="flex items-start gap-3 border-b px-5 py-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 font-semibold">
            {section.title}
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                section.configured
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {section.configured ? '已配置' : '未配置'}
            </span>
          </h2>
          <p className="text-sm text-muted-foreground">{section.description}</p>
        </div>
      </div>

      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        {section.fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={draft[f.key]}
            secret={f.kind === 'secret' ? (section.values[f.key] as SecretValue) : undefined}
            editing={Boolean(editingSecret[f.key])}
            onEdit={(on) => {
              setEditingSecret((s) => ({ ...s, [f.key]: on }))
              if (!on) setDraft((d) => ({ ...d, [f.key]: '' }))
            }}
            onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
          />
        ))}
      </div>

      {extra}

      <AnimatePresence initial={false}>
        {result && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-5"
          >
            <div
              className={cn(
                'mb-4 flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm',
                result.ok
                  ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              {result.ok ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
              ) : (
                <CircleXIcon className="mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0 space-y-0.5">
                <p className="break-words">{result.message}</p>
                {Object.keys(result.details).length > 0 && (
                  <p className="font-mono text-[11px] break-all opacity-75">
                    {Object.entries(result.details)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {section.updated_at ? `上次保存：${relativeTime(section.updated_at)}` : '尚未保存过'}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={onTest} disabled={test.isPending || save.isPending}>
            {test.isPending && <Loader2Icon className="animate-spin" />}
            {dirty ? '保存并测试' : '测试连接'}
          </Button>
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>
    </form>
  )
}

function FieldInput({
  field,
  value,
  secret,
  editing,
  onEdit,
  onChange,
}: {
  field: SettingField
  value: string | boolean
  secret?: SecretValue
  editing: boolean
  onEdit: (on: boolean) => void
  onChange: (value: string | boolean) => void
}) {
  const id = `field-${field.key}`
  const label = (
    <Label htmlFor={id} className="gap-1">
      {field.label}
      {field.required && <span className="text-destructive">*</span>}
    </Label>
  )
  const help = field.help && <p className="text-xs text-muted-foreground">{field.help}</p>

  if (field.kind === 'bool') {
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 sm:col-span-2">
        <div className="space-y-1">
          {label}
          {help}
        </div>
        <Switch id={id} checked={value === true} onCheckedChange={onChange} />
      </div>
    )
  }

  if (field.kind === 'secret') {
    const showInput = editing || !secret?.set
    return (
      <div className="space-y-2 sm:col-span-2">
        {label}
        {showInput ? (
          <div className="flex gap-2">
            {/* new-password 与忽略标记：防止浏览器把登录密码自动填进来 */}
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              data-bwignore
              value={String(value)}
              onChange={(e) => onChange(e.target.value)}
              placeholder={secret?.set ? '输入新值以替换' : '粘贴到这里'}
              className="h-9 font-mono"
            />
            {secret?.set && (
              <Button type="button" variant="ghost" onClick={() => onEdit(false)}>
                取消
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-1.5">
            <span className="font-mono text-sm text-muted-foreground">
              已设置 ••••••{secret?.hint && <span className="text-foreground">{secret.hint}</span>}
            </span>
            <Button type="button" variant="ghost" size="sm" onClick={() => onEdit(true)}>
              更换
            </Button>
          </div>
        )}
        {help}
      </div>
    )
  }

  return (
    <div className={cn('space-y-2', field.key === 'base_url' && 'sm:col-span-2')}>
      {label}
      <Input
        id={id}
        type={field.kind === 'number' ? 'number' : 'text'}
        autoComplete="off"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className="h-9"
      />
      {help}
    </div>
  )
}

function AccountCard() {
  const { data } = useAuthState()
  const logout = useLogout()
  return (
    <div className="flex flex-wrap items-center gap-3 surface rounded-2xl px-5 py-4">
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
        <UserIcon className="size-4" />
      </span>
      <div className="flex-1">
        <p className="font-semibold">账号</p>
        <p className="text-sm text-muted-foreground">
          {data?.username} · 新设备登录需要验证器验证码，受信任设备 30 天内只需密码
        </p>
      </div>
      <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
        <LogOutIcon />
        退出登录
      </Button>
    </div>
  )
}

function AboutCard() {
  const { data } = useHealth()
  return (
    <div className="flex flex-wrap items-center gap-3 surface rounded-2xl px-5 py-4 text-sm">
      <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
        <InfoIcon className="size-4" />
      </span>
      <div className="flex-1">
        <p className="font-semibold">关于</p>
        <p className="text-muted-foreground">
          MindDock {data?.version}
          {data && ` · 构建 ${data.build}${data.commit ? ` (${data.commit})` : ''} · 数据结构 v${data.schema}`}
        </p>
      </div>
      <Button variant="ghost" size="sm" asChild>
        <a href="https://github.com/tianyin231/MindDock" target="_blank" rel="noreferrer noopener">
          GitHub
          <ExternalLinkIcon />
        </a>
      </Button>
    </div>
  )
}
