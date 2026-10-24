import { CircleCheckIcon, Loader2Icon, SendIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useCreateBindCode, useQQ, useSendTestMessage, useUnbind, type QQState } from '@/api/qq'
import { Button } from '@/components/ui/button'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATE_TEXT: Record<QQState['status']['state'], string> = {
  online: '机器人在线',
  connecting: '正在连接',
  unconfigured: '保存 AppID 和 AppSecret 后自动连接',
  error: '连接失败',
  stopped: '机器人服务未运行',
}

/** QQ 设置卡片下方：连接状态与主人绑定 */
export function QQBinding() {
  const { data } = useQQ()
  const create = useCreateBindCode()
  const unbind = useUnbind()
  const sendTest = useSendTestMessage()
  const wasBound = useRef<boolean | null>(null)

  useEffect(() => {
    if (!data) return
    if (wasBound.current === false && data.owner.bound) toast.success('绑定成功，现在可以在 QQ 里给机器人发消息了')
    wasBound.current = data.owner.bound
  }, [data])

  if (!data) return null
  const { status, owner, bind } = data
  const dot = status.online ? 'bg-emerald-500' : status.state === 'error' ? 'bg-destructive' : 'bg-amber-500'

  return (
    <div className="mx-5 mb-4 space-y-3 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot, status.state === 'connecting' && 'animate-pulse')} />
        <div className="min-w-0 text-sm">
          <p className="font-medium">{STATE_TEXT[status.state]}</p>
          {status.detail && !status.online && (
            <p className="text-xs break-words text-muted-foreground">{status.detail}</p>
          )}
        </div>
      </div>

      {owner.bound ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm">
          <span className="flex items-center gap-1.5">
            <CircleCheckIcon className="size-4 text-emerald-500" />
            已绑定你的 QQ{owner.bound_at && <span className="text-muted-foreground">（{relativeTime(owner.bound_at)}）</span>}
          </span>
          <span className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={sendTest.isPending}
              title="QQ 主动消息每月额度有限，不要频繁测试"
              onClick={() =>
                sendTest.mutate(undefined, {
                  onSuccess: (r) => (r.ok ? toast.success(r.message) : toast.error(r.message)),
                  onError: (err) => toast.error(err.message),
                })
              }
            >
              {sendTest.isPending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
              发送测试消息
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unbind.isPending}
              onClick={() => window.confirm('解除后机器人将不再处理你的消息，确定吗？') && unbind.mutate()}
            >
              解除绑定
            </Button>
          </span>
        </div>
      ) : bind ? (
        <div className="space-y-1 rounded-lg bg-muted/60 p-4 text-center">
          <p className="text-xs text-muted-foreground">在 QQ 里给机器人发送</p>
          <p className="font-mono text-2xl font-semibold tracking-widest">绑定 {bind.code}</p>
          <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" />
            10 分钟内有效，等待机器人收到…
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">还没有绑定你的 QQ。绑定后，机器人只处理你发的消息。</p>
          <Button
            type="button"
            size="sm"
            disabled={!data.configured || create.isPending}
            onClick={() => create.mutate()}
          >
            生成绑定码
          </Button>
        </div>
      )}
    </div>
  )
}
