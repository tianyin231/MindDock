import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isDemo } from './client'
import { http } from './http'

export interface BackupResult {
  name: string
  size: number
  createdAt: string
  counts: { items: number; secrets: number; files: number }
  /** 随包带上的文件数（密钥密文、未上传的原件、缩略图） */
  files: number
}

export interface BackupState {
  /** 服务器上是否有备份公钥 */
  configured: boolean
  /** 每天自动备份的时间 */
  schedule: string
  keepLocal: number
  running: boolean
  ok?: boolean
  error?: string | null
  failedAt?: string | null
  last?: BackupResult
  remote?: { ok: boolean; at: string; name?: string; error?: string }
  local: { name: string; size: number }[]
}

export const backupsKey = ['backups'] as const

export function useBackups() {
  return useQuery({
    queryKey: backupsKey,
    queryFn: () => http.get<BackupState>('/api/backups'),
    // 备份进行中时勤快些刷新，好及时显示结果
    refetchInterval: (q) => (q.state.data?.running ? 3000 : 60_000),
    retry: false,
    enabled: !isDemo,
  })
}

export function useBackupNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => http.post<{ queued: boolean }>('/api/backups'),
    onSuccess: () => qc.invalidateQueries({ queryKey: backupsKey }),
  })
}
