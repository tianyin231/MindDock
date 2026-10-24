import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isDemo } from './client'
import { qk } from './hooks'
import { http } from './http'
import type { Item } from './types'

export interface StorageHealth {
  state: 'ok' | 'error'
  failures: number
  error?: string
  since?: string
  /** login：Cookie 已失效；error：其他错误 */
  reason?: 'login' | 'error'
  /** 最近一次失败来自上传还是定时登录检查 */
  source?: 'upload' | 'check'
}

export interface StorageState {
  configured: boolean
  health: StorageHealth
  /** 最近一次和夸克的交互（上传或定时检查）；超过 6 小时没交互会自动检查一次 */
  lastCheck: { at: string; ok: boolean } | null
  /** 原件上传后在服务器上保留的天数 */
  keepDays: number
  counts: { pending: number; uploading: number; uploaded: number; failed: number }
  localFiles: number
  localBytes: number
}

export const storageKey = ['storage'] as const

/** 网盘异常时的标题 */
export function healthTitle(health: StorageHealth): string {
  if (health.reason === 'login') return '夸克登录已失效'
  return health.source === 'check' ? '连不上夸克网盘' : '夸克上传失败'
}

export function useStorage() {
  return useQuery({
    queryKey: storageKey,
    queryFn: () => http.get<StorageState>('/api/storage'),
    refetchInterval: 60_000,
    retry: false,
    // 演示模式没有真实存储
    enabled: !isDemo,
  })
}

export function useRetryFailedUploads() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => http.post<{ requeued: number }>('/api/storage/retry'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: storageKey })
      qc.invalidateQueries({ queryKey: ['items'] })
    },
  })
}

export function useRetryUpload() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (fileId: string) => http.post<Item>(`/api/files/${encodeURIComponent(fileId)}/upload`),
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item)
      qc.invalidateQueries({ queryKey: storageKey })
    },
  })
}
