import { RotateCwIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useRetryFailedUploads, useStorage } from '@/api/storage'
import { Button } from '@/components/ui/button'
import { fileSize } from '@/lib/format'
import { cn } from '@/lib/utils'

/** 夸克网盘设置卡片下方：健康状态、上传统计、服务器暂存占用 */
export function StorageStatus() {
  const { data } = useStorage()
  const retry = useRetryFailedUploads()
  if (!data?.configured) return null

  const { health, counts } = data
  const broken = health.state === 'error'
  const stats = [
    { label: '待上传', value: counts.pending + counts.uploading },
    { label: '已上传', value: counts.uploaded },
    { label: '失败', value: counts.failed, alert: counts.failed > 0 },
  ]

  return (
    <div className="mx-5 mb-4 space-y-3 rounded-lg border p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', broken ? 'bg-destructive' : 'bg-emerald-500')} />
        <div className="min-w-0">
          <p className="font-medium">{broken ? '上传失败' : '网盘正常'}</p>
          {broken && (
            <p className="text-xs break-words text-muted-foreground">
              {health.error}。新文件会先保存在服务器上，更新 Cookie 后自动补传
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 border-t pt-3 text-center">
        {stats.map((s) => (
          <div key={s.label}>
            <p className={cn('text-lg font-semibold tabular-nums', s.alert && 'text-destructive')}>{s.value}</p>
            <p className="text-xs text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          服务器暂存 {data.localFiles} 个原件，共 {fileSize(data.localBytes)}；上传后保留 {data.keepDays} 天
        </p>
        {counts.failed > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={retry.isPending}
            onClick={() =>
              retry.mutate(undefined, {
                onSuccess: (r) => toast.success(`已重新排队 ${r.requeued} 个文件`),
                onError: (err) => toast.error(err.message),
              })
            }
          >
            <RotateCwIcon />
            全部重试
          </Button>
        )}
      </div>
    </div>
  )
}
