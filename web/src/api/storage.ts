import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isDemo } from './client'
import { qk } from './hooks'
import { http } from './http'
import type { Item } from './types'

export interface StorageState {
  configured: boolean
  health: { state: 'ok' | 'error'; failures: number; error?: string; since?: string }
  /** 原件上传后在服务器上保留的天数 */
  keepDays: number
  counts: { pending: number; uploading: number; uploaded: number; failed: number }
  localFiles: number
  localBytes: number
}

export const storageKey = ['storage'] as const

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
