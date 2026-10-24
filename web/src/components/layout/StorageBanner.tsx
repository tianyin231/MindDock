import { CloudAlertIcon } from 'lucide-react'
import { Link } from 'react-router'
import { useStorage } from '@/api/storage'

/** 夸克网盘连续上传失败时，在每个页面顶部提示 */
export function StorageBanner() {
  const { data } = useStorage()
  if (!data?.configured || data.health.state !== 'error') return null
  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm">
      <CloudAlertIcon className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">夸克网盘上传失败</span>
        <span className="text-muted-foreground">
          ：{data.health.error}。新文件会先保存在服务器上，更新 Cookie 后自动补传
        </span>
      </p>
      <Link to="/settings" className="shrink-0 font-medium text-destructive underline-offset-4 hover:underline">
        去设置
      </Link>
    </div>
  )
}
