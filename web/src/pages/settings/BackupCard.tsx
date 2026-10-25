import { ArchiveIcon, DownloadIcon, Loader2Icon, PlayIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { useBackupNow, useBackups, type BackupState } from '@/api/backups'
import { Button } from '@/components/ui/button'
import { fileSize, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

/** minddock-20261025-031500.tar.gz.age → 10月25日 03:15 */
function backupLabel(name: string): string {
  const m = name.match(/^minddock-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/)
  return m ? `${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}` : name
}

/** 设置页的备份卡片：状态、立即备份、本地备份下载 */
export function BackupCard() {
  const { data } = useBackups()
  const run = useBackupNow()
  if (!data) return null

  const start = () =>
    run.mutate(undefined, {
      onSuccess: () => toast.success('已开始备份，完成后这里会更新'),
      onError: (err) => toast.error(err.message),
    })

  return (
    <section className="surface rounded-2xl">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-3">
        <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
          <ArchiveIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">备份</p>
          <p className="text-sm text-muted-foreground">
            每天 {data.schedule} 自动加密备份，服务器保留最近 {data.keepLocal} 份，并上传夸克
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={!data.configured || data.running || run.isPending} onClick={start}>
          {data.running ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
          {data.running ? '正在备份' : '立即备份'}
        </Button>
      </div>

      <div className="mx-5 mb-4 space-y-3 rounded-lg border p-3 text-sm">
        <BackupStatus data={data} />
        {data.local.length > 0 && (
          <ul className="space-y-0.5 border-t pt-2">
            {data.local.map((b) => (
              <li key={b.name}>
                <a
                  href={`/api/backups/${encodeURIComponent(b.name)}`}
                  download
                  className="group flex items-center gap-3 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/60"
                >
                  <span className="flex-1 font-mono text-xs">{backupLabel(b.name)}</span>
                  <span className="text-xs text-muted-foreground">{fileSize(b.size)}</span>
                  <DownloadIcon className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t pt-2 text-xs leading-relaxed text-muted-foreground">
          备份用 age 公钥加密，只有你保存的备份私钥能解开。迁移到新服务器时，把一份备份交给 install.sh --restore 即可。
        </p>
      </div>
    </section>
  )
}

function BackupStatus({ data }: { data: BackupState }) {
  if (!data.configured) {
    return (
      <Line tone="warn" title="还没有备份密钥">
        在服务器上运行 <code className="rounded bg-muted px-1 font-mono">bash /opt/minddock/deploy/backup.sh</code>{' '}
        生成密钥并立即备份一次
      </Line>
    )
  }
  if (data.ok === false) {
    return (
      <Line tone="error" title="备份失败">
        {data.error}。每小时会自动重试
      </Line>
    )
  }
  if (!data.last) {
    return <Line tone="warn" title="还没有备份">稍后会自动备份一次，也可以点"立即备份"</Line>
  }
  const { last, remote } = data
  const uploaded = remote?.ok && remote.name === last.name
  return (
    <Line tone="ok" title={`备份正常 · ${relativeTime(last.createdAt)}`}>
      {fileSize(last.size)} · 条目 {last.counts.items}、密钥 {last.counts.secrets}
      {' · '}
      {uploaded ? (
        '已上传夸克'
      ) : remote && !remote.ok ? (
        <span className="text-amber-700 dark:text-amber-400">上传夸克失败：{remote.error}</span>
      ) : (
        '只保存在服务器上（夸克未配置）'
      )}
    </Line>
  )
}

function Line({ tone, title, children }: { tone: 'ok' | 'warn' | 'error'; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-destructive',
        )}
      />
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-xs break-words text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}
