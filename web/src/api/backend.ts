import type { Api } from './client'
import { ApiError, http } from './http'
import type {
  Counts,
  Item,
  ItemPartition,
  LiveEvent,
  ReminderAction,
  Secret,
  VaultKeysData,
  VaultRewrapBody,
  VaultSetupBody,
  VaultState,
} from './types'

/** 真实后端：JSON 接口 + SSE 实时事件 */
export const httpBackend: Api = {
  counts: () => http.get<Counts>('/api/counts'),
  listItems: (partition: ItemPartition) => http.get<Item[]>(`/api/items?partition=${partition}`),
  getItem: (id: string) =>
    http.get<Item>(`/api/items/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof ApiError && err.status === 404) return null
      throw err
    }),
  search: (q: string) => http.get<Item[]>(`/api/search?q=${encodeURIComponent(q)}`),
  setTodoDone: (id: string, done: boolean) => http.post<Item>(`/api/items/${id}/todo`, { done }),
  addTodo: (title: string) => http.post<Item>('/api/todos', { title }),
  moveItem: (id: string, partition: ItemPartition) => http.post<Item>(`/api/items/${id}/move`, { partition }),
  reminderAction: (id: string, body: ReminderAction) => http.post<Item>(`/api/items/${id}/reminder`, body),
  retryItem: async (id: string) => {
    await http.post(`/api/items/${id}/retry`)
  },
  vaultState: () => http.get<VaultState>('/api/vault'),
  vaultSetup: (body: VaultSetupBody) => http.post<VaultState>('/api/vault/setup', body),
  vaultKeys: () => http.get<VaultKeysData>('/api/vault/keys'),
  vaultChallenge: () => http.post<{ token: string; sealed: string }>('/api/vault/challenge'),
  vaultRewrap: async (body: VaultRewrapBody) => {
    await http.put('/api/vault/keys', body)
  },
  listSecrets: () => http.get<Secret[]>('/api/secrets'),
  secretBlob: async (id: string) => {
    const resp = await fetch(`/api/secrets/${encodeURIComponent(id)}/blob`, { credentials: 'same-origin' })
    if (!resp.ok) throw new ApiError(resp.status, '读取密文失败')
    return new Uint8Array(await resp.arrayBuffer())
  },
  addSecret: (label: string, sealed: string) => http.post<Secret>('/api/secrets', { label, sealed }),
  deleteSecret: async (id: string) => {
    await http.delete(`/api/secrets/${encodeURIComponent(id)}`)
  },
  releaseSecret: (id: string, text: string) =>
    http.post<Item>(`/api/secrets/${encodeURIComponent(id)}/release`, { text }),
  subscribe(listener: (e: LiveEvent) => void) {
    // EventSource 断线后会按服务端给的 retry 自动重连，并带上 Last-Event-ID
    const source = new EventSource('/api/events')
    source.onmessage = (e) => {
      try {
        listener(JSON.parse(e.data) as LiveEvent)
      } catch {
        // 忽略无法解析的事件
      }
    }
    return () => source.close()
  },
}
