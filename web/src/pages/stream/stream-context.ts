import { createContext, use } from 'react'
import type { PartitionKey, TimelineEntry } from '@/api/types'

export interface StreamState {
  /** 鼠标停在哪个分区上：时间线里其他分区的卡片变淡 */
  hover: PartitionKey | null
  /** 正在拖动的卡片，以及指针下方的分区 */
  dragging: string | null
  drop: PartitionKey | null
  setDragging(id: string | null): void
  setDrop(partition: PartitionKey | null): void
}

export const StreamContext = createContext<StreamState | null>(null)

export function useStream(): StreamState {
  const value = use(StreamContext)
  if (!value) throw new Error('useStream 必须在收件台页面内使用')
  return value
}

export const partitionOf = (e: TimelineEntry): PartitionKey => (e.kind === 'secret' ? 'secret' : e.item.partition)

export const createdAtOf = (e: TimelineEntry) => (e.kind === 'secret' ? e.secret.createdAt : e.item.createdAt)
