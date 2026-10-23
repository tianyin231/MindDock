import { createContext, use } from 'react'
import type { PartitionKey } from '@/api/types'

export type CardKind = 'text' | 'link' | 'image' | 'video' | 'audio' | 'file' | 'secret'

export interface LiveCard {
  id: string
  itemId?: string
  title: string
  preview: string
  kind: CardKind
  stage: 'processing' | 'sorted'
  target?: PartitionKey
}

export interface Landing {
  id: string
  target: PartitionKey
  title: string
}

export interface Recent {
  id: string
  itemId?: string
  target: PartitionKey
  title: string
  at: number
}

/** 归类完成后，卡片显示"→ 分区"的停留时间 */
export const SORTED_HOLD_MS = 700
/** 飞行加落定的时间，需要与格子里标签的动画时长匹配 */
export const FLIGHT_MS = 850

export interface LiveSortValue {
  cards: LiveCard[]
  landings: Landing[]
  recents: Recent[]
  /** 每个分区的落地次数，变化时格子闪一下 */
  bumps: Partial<Record<PartitionKey, number>>
  auto: boolean
  setAuto(on: boolean): void
  simulate(): void
}

export const LiveSortContext = createContext<LiveSortValue | null>(null)

export function useLiveSort(): LiveSortValue {
  const value = use(LiveSortContext)
  if (!value) throw new Error('useLiveSort 必须在 LiveSortProvider 内使用')
  return value
}
