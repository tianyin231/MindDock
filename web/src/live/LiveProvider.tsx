/**
 * 实时归类：订阅后端事件，就地更新缓存，并把"收到 → AI 归类 → 落入分区"的过程变成看得见的动画。
 *
 * 收件台里的卡片是持久的：收到时出现在时间线顶部，识别中边缘有光流动，归类后盖上分区印章，
 * 再由一个小标签从印章（或页面上的收件台入口）飞到分区落点，落地那一刻分区计数才刷新。
 * 起点和落点都由各页面注册，所以在总览、收件台、其他页面的侧边栏上都能看到同一套动画。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { qk } from '@/api/hooks'
import { patchTimelineItem, prependEntry } from '@/api/timeline-cache'
import type { LiveEvent, PartitionKey } from '@/api/types'
import { PARTITION } from '@/lib/partitions'
import { FlightLayer } from './FlightLayer'
import { FLIGHT_MS, LiveContext, ORIGIN, STAMP_HOLD_MS, type Flight, type LiveValue } from './live'

interface Reg {
  el: HTMLElement
  priority: number
}

function visible(el: HTMLElement): DOMRect | null {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return null
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return null
  return r
}

function pick(regs: Set<Reg> | undefined): { el: HTMLElement; rect: DOMRect } | null {
  let best: { el: HTMLElement; rect: DOMRect; priority: number } | null = null
  for (const reg of regs ?? []) {
    if (best && reg.priority <= best.priority) continue
    const rect = visible(reg.el)
    if (rect) best = { el: reg.el, rect, priority: reg.priority }
  }
  return best
}

function register<K>(map: Map<K, Set<Reg>>, key: K, reg: Reg): () => void {
  const set = map.get(key) ?? new Set<Reg>()
  set.add(reg)
  map.set(key, set)
  return () => {
    set.delete(reg)
    if (set.size === 0) map.delete(key)
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const reduced = useReducedMotion()
  const [bumps, setBumps] = useState<Partial<Record<PartitionKey, number>>>({})
  const [flights, setFlights] = useState<Flight[]>([])
  const [auto, setAutoState] = useState(() => api.demo?.isAuto() ?? false)

  const sources = useRef(new Map<string, Set<Reg>>())
  const targets = useRef(new Map<PartitionKey, Set<Reg>>())

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach(clearTimeout)
  }, [])
  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
  }, [])

  const registerSource = useCallback(
    (key: string, el: HTMLElement, priority: number) => register(sources.current, key, { el, priority }),
    [],
  )
  const registerTarget = useCallback(
    (partition: PartitionKey, el: HTMLElement, priority: number) =>
      register(targets.current, partition, { el, priority }),
    [],
  )

  /** 落地：落点闪一下，计数和分区列表从服务器刷新 */
  const settle = useCallback(
    (partition: PartitionKey) => {
      setBumps((b) => ({ ...b, [partition]: (b[partition] ?? 0) + 1 }))
      qc.invalidateQueries({ queryKey: qk.counts })
      qc.invalidateQueries({ queryKey: partition === 'secret' ? qk.secrets : qk.items(partition) })
      qc.invalidateQueries({ queryKey: qk.items('inbox') })
    },
    [qc],
  )

  const launch = useCallback(
    (from: DOMRect, partition: PartitionKey, title: string): boolean => {
      const to = pick(targets.current.get(partition))
      if (reduced || !to) {
        settle(partition)
        return false
      }
      const flight: Flight = { id: `${Date.now()}-${Math.random()}`, partition, title, from, to: to.rect }
      setFlights((fs) => [...fs, flight])
      later(FLIGHT_MS, () => settle(partition))
      later(FLIGHT_MS + 400, () => setFlights((fs) => fs.filter((f) => f.id !== flight.id)))
      return true
    },
    [later, reduced, settle],
  )

  const fly = useCallback(
    (from: HTMLElement, partition: PartitionKey, title: string) => {
      const rect = visible(from)
      if (!rect) {
        settle(partition)
        return false
      }
      return launch(rect, partition, title)
    },
    [launch, settle],
  )

  /** 归类完成：优先从条目自己的卡片起飞；看不到卡片就从收件台入口起飞；都不行再弹通知 */
  const announce = useCallback(
    (key: string, partition: PartitionKey, title: string) => {
      const own = pick(sources.current.get(key))
      if (own) {
        launch(own.rect, partition, title)
        return
      }
      const origin = pick(sources.current.get(ORIGIN))
      if (origin && launch(origin.rect, partition, title)) return
      if (!origin) settle(partition)
      toast(`已归入「${PARTITION[partition].label}」`, { description: title })
    },
    [launch, settle],
  )

  const targetAt = useCallback((x: number, y: number) => {
    let best: { key: PartitionKey; priority: number } | null = null
    for (const [key, regs] of targets.current) {
      for (const reg of regs) {
        const r = visible(reg.el)
        if (!r || x < r.left || x > r.right || y < r.top || y > r.bottom) continue
        if (!best || reg.priority > best.priority) best = { key, priority: reg.priority }
      }
    }
    return best?.key ?? null
  }, [])

  useEffect(() => {
    const handle = (e: LiveEvent) => {
      if (e.type === 'item.received') {
        prependEntry(qc, { kind: 'item', item: e.item })
        qc.invalidateQueries({ queryKey: qk.counts })
        qc.invalidateQueries({ queryKey: qk.items('inbox') })
      } else if (e.type === 'item.classified') {
        const { item } = e
        qc.setQueryData(qk.item(item.id), item)
        // 卡片立即盖章，稍后起飞
        patchTimelineItem(qc, item)
        later(STAMP_HOLD_MS, () => announce(item.id, item.partition, item.title))
      } else if (e.type === 'item.updated') {
        // 附件下载完成、手动改分区、归类失败等：就地更新，不播放飞行动画
        qc.setQueryData(qk.item(e.item.id), e.item)
        patchTimelineItem(qc, e.item)
        qc.invalidateQueries({ queryKey: ['items'] })
        qc.invalidateQueries({ queryKey: qk.counts })
      } else if (e.type === 'qq.bound') {
        qc.invalidateQueries({ queryKey: ['qq'] })
      } else {
        const { secret } = e
        prependEntry(qc, { kind: 'secret', secret })
        later(STAMP_HOLD_MS, () => announce(secret.id, 'secret', secret.label))
      }
    }
    return api.subscribe(handle)
  }, [announce, later, qc])

  const value = useMemo<LiveValue>(
    () => ({
      bumps,
      registerSource,
      registerTarget,
      fly,
      targetAt,
      auto,
      setAuto(on) {
        api.demo?.setAuto(on)
        setAutoState(on)
      },
      simulate() {
        api.demo?.simulate()
      },
    }),
    [auto, bumps, fly, registerSource, registerTarget, targetAt],
  )

  return (
    <LiveContext value={value}>
      {children}
      <FlightLayer flights={flights} />
    </LiveContext>
  )
}
