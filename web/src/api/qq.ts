import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { http } from './http'

export interface QQState {
  configured: boolean
  status: { state: 'online' | 'connecting' | 'unconfigured' | 'error' | 'stopped'; detail: string; online: boolean }
  owner: { bound: boolean; bound_at: string | null }
  bind: { code: string; expires_at: string } | null
}

export const qqKey = ['qq'] as const

export function useQQ() {
  return useQuery({
    queryKey: qqKey,
    queryFn: () => http.get<QQState>('/api/qq'),
    // 显示绑定码时频繁刷新，绑定成功后马上反映出来
    refetchInterval: (query) => (query.state.data?.bind ? 3000 : 30_000),
  })
}

export function useCreateBindCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => http.post<QQState>('/api/qq/bind'),
    onSuccess: (state) => qc.setQueryData(qqKey, state),
  })
}

/** 发一条主动消息，检查到点提醒能否送达 */
export function useSendTestMessage() {
  return useMutation({
    mutationFn: () => http.post<{ ok: boolean; message: string }>('/api/qq/test'),
  })
}

export function useUnbind() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => http.delete<QQState>('/api/qq/owner'),
    onSuccess: (state) => qc.setQueryData(qqKey, state),
  })
}
