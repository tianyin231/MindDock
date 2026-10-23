import { mockBackend } from './mock/store'
import type { Counts, Item, ItemPartition, LiveEvent, Secret } from './types'

/** 前端访问后端的唯一入口。接入真实接口时，只需替换这里的实现。 */
export interface Api {
  counts(): Promise<Counts>
  listItems(partition: ItemPartition): Promise<Item[]>
  getItem(id: string): Promise<Item | null>
  search(q: string): Promise<Item[]>
  setTodoDone(id: string, done: boolean): Promise<Item>
  addTodo(title: string): Promise<Item>
  moveItem(id: string, partition: ItemPartition): Promise<Item>
  retryItem(id: string): Promise<void>
  listSecrets(): Promise<Secret[]>
  unlockVault(password: string): Promise<Record<string, string>>
  subscribe(listener: (e: LiveEvent) => void): () => void
  /** 仅演示模式提供：手动或自动模拟收到新消息 */
  demo?: {
    simulate(): void
    isAuto(): boolean
    setAuto(on: boolean): void
  }
}

export const api: Api = mockBackend
export const isDemo = Boolean(api.demo)
