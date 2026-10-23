import type { Api } from './client'
import { ApiError, http } from './http'
import type { Counts, Item, ItemPartition, LiveEvent, Secret } from './types'

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
  retryItem: async (id: string) => {
    await http.post(`/api/items/${id}/retry`)
  },
  listSecrets: () => http.get<Secret[]>('/api/secrets'),
  unlockVault: async () => {
    throw new Error('密钥库将在下一个版本启用')
  },
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
