/** 收件台缓存的就地更新：实时事件和各种操作都直接改缓存里的那一条，不重新拉整条时间线 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import type { Item, TimelineEntry, TimelinePage } from './types'

export const timelineKey = ['timeline'] as const

type Data = InfiniteData<TimelinePage, string | undefined>

export const entryId = (e: TimelineEntry) => (e.kind === 'item' ? e.item.id : e.secret.id)

const has = (d: Data, id: string) => d.pages.some((p) => p.entries.some((e) => entryId(e) === id))

/** 新收到的放到最前面；已经在列表里（实时事件和接口返回都会带来同一条）就原地替换 */
export function prependEntry(qc: QueryClient, entry: TimelineEntry) {
  qc.setQueryData<Data>(timelineKey, (d) => {
    if (!d || d.pages.length === 0) return d
    if (has(d, entryId(entry))) return replace(d, entry)
    const [first, ...rest] = d.pages
    return { ...d, pages: [{ ...first, entries: [entry, ...first.entries] }, ...rest] }
  })
}

/** 条目有变化（归类、移动、勾选…）时更新；不在已加载的范围内就忽略 */
export function patchTimelineItem(qc: QueryClient, item: Item) {
  mapTimelineItem(qc, item.id, () => item)
}

export function mapTimelineItem(qc: QueryClient, id: string, fn: (item: Item) => Item) {
  qc.setQueryData<Data>(timelineKey, (d) => {
    if (!d) return d
    const found = d.pages.flatMap((p) => p.entries).find((e) => e.kind === 'item' && e.item.id === id)
    return found?.kind === 'item' ? replace(d, { kind: 'item', item: fn(found.item) }) : d
  })
}

function replace(d: Data, entry: TimelineEntry): Data {
  const id = entryId(entry)
  return {
    ...d,
    pages: d.pages.map((p) => ({ ...p, entries: p.entries.map((e) => (entryId(e) === id ? entry : e)) })),
  }
}
