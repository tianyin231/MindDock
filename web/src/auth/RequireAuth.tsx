import { Loader2Icon, WifiOffIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router'
import { Button } from '@/components/ui/button'
import { useAuthState } from './auth'

/** 未初始化跳到初始化页，未登录跳到登录页，并记住原本要去的地址 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading, isError, refetch } = useAuthState()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        <Loader2Icon className="size-5 animate-spin" />
      </div>
    )
  }
  if (isError || !data) {
    return (
      <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
        <WifiOffIcon className="size-8 text-muted-foreground" />
        <p className="font-medium">无法连接 MindDock 服务器</p>
        <Button variant="outline" onClick={() => refetch()}>
          重试
        </Button>
      </div>
    )
  }
  if (data.setup_required) return <Navigate to="/setup" replace />
  if (!data.authenticated) {
    const next = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?next=${next}`} replace />
  }
  return children
}
