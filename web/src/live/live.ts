import { createContext, use, useCallback } from 'react'
import type { PartitionKey } from '@/api/types'

/** 归类完成后，卡片先盖上分区印章，停留这么久再起飞 */
export const STAMP_HOLD_MS = 650
/** 飞行时长；落地时分区计数才刷新，数字跳动与落地同步 */
export const FLIGHT_MS = 850

/** 各页面"收件台"入口的起点键：找不到条目本身的卡片时，从这里起飞 */
export const ORIGIN = 'origin'

export interface Flight {
  id: string
  partition: PartitionKey
  title: string
  from: DOMRect
  to: DOMRect
}

type RefCleanup = (el: HTMLElement | null) => (() => void) | void

export interface LiveValue {
  /** 每个分区的落地次数，变化时落点闪一下 */
  bumps: Partial<Record<PartitionKey, number>>
  /** 注册飞行起点（条目 id 或 ORIGIN）；同一个键有多个可见元素时取优先级高的 */
  registerSource(key: string, el: HTMLElement, priority: number): () => void
  /** 注册分区落点：收件台分区栏 3、总览分区格 2、侧边栏 1 */
  registerTarget(partition: PartitionKey, el: HTMLElement, priority: number): () => void
  /** 从某个元素飞向分区，返回是否真的飞了（落点不可见或减少动态效果时直接落地） */
  fly(from: HTMLElement, partition: PartitionKey, title: string): boolean
  /** 找到当前可见的分区落点元素，用于拖放时判断指针下方是哪个分区 */
  targetAt(x: number, y: number): PartitionKey | null
  auto: boolean
  setAuto(on: boolean): void
  simulate(): void
}

export const LiveContext = createContext<LiveValue | null>(null)

export function useLive(): LiveValue {
  const value = use(LiveContext)
  if (!value) throw new Error('useLive 必须在 LiveProvider 内使用')
  return value
}

export function useBump(partition: PartitionKey): number {
  return useLive().bumps[partition] ?? 0
}

export function useFlightSource(key: string, priority = 1): RefCleanup {
  const { registerSource } = useLive()
  return useCallback((el) => (el ? registerSource(key, el, priority) : undefined), [registerSource, key, priority])
}

export function useFlightTarget(partition: PartitionKey | undefined, priority: number): RefCleanup {
  const { registerTarget } = useLive()
  return useCallback(
    (el) => (el && partition ? registerTarget(partition, el, priority) : undefined),
    [registerTarget, partition, priority],
  )
}
