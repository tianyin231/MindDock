/**
 * 实时归类：把"收到 → AI 归类 → 落入分区"的过程变成可见的动画。
 *
 * 卡片在收件流中以 layoutId 渲染；归类完成后，卡片从收件流移除，同时在目标分区格子里
 * 渲染一个同 layoutId 的小标签，Motion 会把它从卡片的位置飞到格子里（共享元素动画）。
 * 分区计数在落地那一刻才 +1，所以数字跳动和卡片落地是同步的。
 */
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { qk } from '@/api/hooks'
import type { Counts, Item, LiveEvent, PartitionKey } from '@/api/types'
import { PARTITION } from '@/lib/partitions'
import {
  FLIGHT_MS,
  LiveSortContext,
  SORTED_HOLD_MS,
  type CardKind,
  type Landing,
  type LiveCard,
  type LiveSortValue,
  type Recent,
} from './live-sort'

function kindOf(item: Item): CardKind {
  const first = item.attachments[0]
  if (first) return first.kind
  return /https?:\/\//.test(item.text) ? 'link' : 'text'
}

export function LiveSortProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const { pathname } = useLocation()
  const onOverview = useRef(pathname === '/')
  useEffect(() => {
    onOverview.current = pathname === '/'
  }, [pathname])

  const [cards, setCards] = useState<LiveCard[]>([])
  const [landings, setLandings] = useState<Landing[]>([])
  const [recents, setRecents] = useState<Recent[]>([])
  const [bumps, setBumps] = useState<Partial<Record<PartitionKey, number>>>({})
  const [auto, setAutoState] = useState(() => api.demo?.isAuto() ?? false)

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

  const adjustCount = useCallback(
    (key: PartitionKey, delta: number) =>
      qc.setQueryData<Counts>(qk.counts, (c) => (c ? { ...c, [key]: Math.max(0, c[key] + delta) } : c)),
    [qc],
  )

  const land = useCallback(
    (card: { id: string; itemId?: string; target: PartitionKey; title: string }) => {
      // 卡片离开收件流，同 layoutId 的标签出现在目标格子里
      setCards((cs) => cs.filter((c) => c.id !== card.id))
      setLandings((ls) => [...ls, { id: card.id, target: card.target, title: card.title }])

      later(FLIGHT_MS, () => {
        setLandings((ls) => ls.filter((l) => l.id !== card.id))
        setRecents((rs) => [{ ...card, at: Date.now() }, ...rs].slice(0, 6))
        setBumps((b) => ({ ...b, [card.target]: (b[card.target] ?? 0) + 1 }))
        adjustCount(card.target, 1)
        qc.invalidateQueries({ queryKey: card.target === 'secret' ? qk.secrets : ['items', card.target] })
      })
    },
    [adjustCount, later, qc],
  )

  useEffect(() => {
    const announce = (target: PartitionKey, title: string) => {
      if (!onOverview.current) toast(`已归入「${PARTITION[target].label}」`, { description: title })
    }

    const handle = (e: LiveEvent) => {
      if (e.type === 'item.received') {
        const { item } = e
        adjustCount('inbox', 1)
        qc.invalidateQueries({ queryKey: qk.items('inbox') })
        setCards((cs) => [
          { id: item.id, itemId: item.id, title: item.title, preview: item.text, kind: kindOf(item), stage: 'processing' },
          ...cs,
        ])
      } else if (e.type === 'item.classified') {
        const { item } = e
        adjustCount('inbox', -1)
        qc.invalidateQueries({ queryKey: qk.items('inbox') })
        qc.setQueryData(qk.item(item.id), item)
        setCards((cs) => {
          const sorted: LiveCard = {
            id: item.id,
            itemId: item.id,
            title: item.title,
            preview: item.text,
            kind: kindOf(item),
            stage: 'sorted',
            target: item.partition,
          }
          // 页面打开前就已在处理的条目（比如重试），没有对应卡片，直接补一张
          return cs.some((c) => c.id === item.id) ? cs.map((c) => (c.id === item.id ? sorted : c)) : [sorted, ...cs]
        })
        later(SORTED_HOLD_MS, () => land({ id: item.id, itemId: item.id, target: item.partition, title: item.title }))
        announce(item.partition, item.title)
      } else if (e.type === 'item.updated') {
        // 附件下载完成、手动改分区、归类失败等：刷新相关数据即可，不播放动画
        qc.setQueryData(qk.item(e.item.id), e.item)
        qc.invalidateQueries({ queryKey: ['items'] })
        qc.invalidateQueries({ queryKey: qk.counts })
      } else if (e.type === 'qq.bound') {
        qc.invalidateQueries({ queryKey: ['qq'] })
      } else {
        const { secret } = e
        setCards((cs) => [
          {
            id: secret.id,
            title: secret.label,
            preview: '已识别为密钥，内容已加密保存',
            kind: 'secret',
            stage: 'sorted',
            target: 'secret',
          },
          ...cs,
        ])
        later(SORTED_HOLD_MS + 300, () => land({ id: secret.id, target: 'secret', title: secret.label }))
        announce('secret', secret.label)
      }
    }

    return api.subscribe(handle)
  }, [adjustCount, land, later, qc])

  const value = useMemo<LiveSortValue>(
    () => ({
      cards,
      landings,
      recents,
      bumps,
      auto,
      setAuto(on) {
        api.demo?.setAuto(on)
        setAutoState(on)
      },
      simulate() {
        api.demo?.simulate()
      },
    }),
    [auto, bumps, cards, landings, recents],
  )

  return <LiveSortContext value={value}>{children}</LiveSortContext>
}
