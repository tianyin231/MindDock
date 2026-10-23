import { httpBackend } from './backend'
import { mockBackend } from './mock/store'
import type { Counts, Item, ItemPartition, LiveEvent, Secret } from './types'

/** 前端访问后端的唯一入口 */
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

/** VITE_DEMO=1 时使用内存里的演示数据，不需要后端（用于界面开发和截图） */
export const isDemo = import.meta.env.VITE_DEMO === '1'
export const api: Api = isDemo ? mockBackend : httpBackend
