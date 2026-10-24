/**
 * 内存版后端：在接入真实接口之前，用来驱动整个前端和归类动画。
 * 行为对齐设计文档：新消息先进"处理中"，AI 归类后进入分区；密钥在收件时直接分流。
 */
import type { Counts, Item, ItemPartition, LiveEvent, ReminderAction, Secret } from '../types'
import { INCOMING, makeCode, makeId, seedItems, seedSecrets } from './seed'

const items = new Map<string, Item>(seedItems().map((i) => [i.id, i]))
const secrets: Secret[] = []
const secretValues = new Map<string, string>()
for (const { secret, value } of seedSecrets()) {
  secrets.push(secret)
  secretValues.set(secret.id, value)
}

const listeners = new Set<(e: LiveEvent) => void>()
const emit = (e: LiveEvent) => listeners.forEach((l) => l(structuredClone(e)))

const clone = <T>(v: T): T => structuredClone(v)
const latency = (ms = 120) => new Promise((r) => setTimeout(r, ms + Math.random() * 80))

function mustGet(id: string): Item {
  const found = items.get(id)
  if (!found) throw new Error(`条目不存在：${id}`)
  return found
}

function sortForPartition(list: Item[], partition: ItemPartition): Item[] {
  if (partition === 'todo') {
    const due = (i: Item) => (i.todo?.dueAt ? Date.parse(i.todo.dueAt) : Number.MAX_SAFE_INTEGER)
    return list.sort((a, b) => Number(!!a.todo?.doneAt) - Number(!!b.todo?.doneAt) || due(a) - due(b))
  }
  if (partition === 'reminder') {
    const at = (i: Item) => (i.reminder ? Date.parse(i.reminder.remindAt) : Number.MAX_SAFE_INTEGER)
    return list.sort((a, b) => at(a) - at(b))
  }
  return list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

// ---- 演示：模拟收到新消息 ----

let cursor = 0
let auto = true
let autoTimer: ReturnType<typeof setTimeout> | undefined

function simulateIncoming(): void {
  const tpl = INCOMING[cursor++ % INCOMING.length]
  const now = new Date().toISOString()

  if (tpl.secret) {
    // 密钥在收件阶段就被识别并加密，不经过 AI
    const secret: Secret = { id: makeId(), code: makeCode(), label: tpl.secret.label, kind: 'text', createdAt: now }
    secrets.unshift(secret)
    secretValues.set(secret.id, tpl.secret.value)
    emit({ type: 'secret.stored', secret })
    return
  }

  const result = tpl.result!
  const fresh: Item = {
    id: makeId(),
    code: makeCode(),
    source: 'qq',
    partition: 'inbox',
    partitionSource: 'auto',
    text: tpl.preview,
    title: tpl.preview,
    tags: [],
    createdAt: now,
    attachments: (result.attachments ?? []).map((a) => ({ ...a, id: makeId() })),
    processing: { stage: 'organizing' },
  }
  items.set(fresh.id, fresh)
  emit({ type: 'item.received', item: fresh })

  setTimeout(
    () => {
      const current = items.get(fresh.id)
      if (!current) return
      const classified: Item = {
        ...current,
        ...clone(result),
        attachments: current.attachments,
        tags: result.tags ?? [],
        processing: undefined,
        ai: { model: 'gpt-compatible', at: new Date().toISOString() },
      }
      items.set(classified.id, classified)
      emit({ type: 'item.classified', item: classified })
    },
    1600 + Math.random() * 900,
  )
}

function scheduleAuto(delay = 6500 + Math.random() * 4000): void {
  clearTimeout(autoTimer)
  autoTimer = undefined
  if (!auto || listeners.size === 0) return
  autoTimer = setTimeout(() => {
    simulateIncoming()
    scheduleAuto()
  }, delay)
}

// ---- 对外接口 ----

export const mockBackend = {
  async counts(): Promise<Counts> {
    await latency(60)
    const counts: Counts = { inbox: 0, note: 0, bookmark: 0, todo: 0, reminder: 0, secret: secrets.length, file: 0 }
    for (const i of items.values()) counts[i.partition]++
    return counts
  },

  async listItems(partition: ItemPartition): Promise<Item[]> {
    await latency()
    return clone(sortForPartition([...items.values()].filter((i) => i.partition === partition), partition))
  },

  async getItem(id: string): Promise<Item | null> {
    await latency(60)
    return clone(items.get(id) ?? null)
  },

  async search(q: string): Promise<Item[]> {
    await latency()
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const hits = [...items.values()].filter((i) =>
      [i.title, i.text, i.summary ?? '', i.link?.site ?? '', ...i.tags, ...i.attachments.map((a) => a.name)]
        .join('\n')
        .toLowerCase()
        .includes(needle),
    )
    return clone(hits.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
  },

  async setTodoDone(id: string, done: boolean): Promise<Item> {
    await latency(80)
    const target = mustGet(id)
    target.todo = { ...target.todo, doneAt: done ? new Date().toISOString() : undefined }
    return clone(target)
  },

  async addTodo(title: string): Promise<Item> {
    await latency(80)
    const created: Item = {
      id: makeId(),
      code: makeCode(),
      source: 'panel',
      partition: 'todo',
      partitionSource: 'user',
      text: title,
      title,
      tags: [],
      createdAt: new Date().toISOString(),
      attachments: [],
      todo: {},
    }
    items.set(created.id, created)
    return clone(created)
  },

  async moveItem(id: string, partition: ItemPartition): Promise<Item> {
    await latency(80)
    const target = mustGet(id)
    target.partition = partition
    target.partitionSource = 'user'
    target.processing = undefined
    if (partition === 'todo' && !target.todo) target.todo = {}
    if (partition !== 'reminder' && target.reminder?.status === 'scheduled') target.reminder.status = 'cancelled'
    return clone(target)
  },

  async reminderAction(id: string, body: ReminderAction): Promise<Item> {
    await latency(80)
    const target = mustGet(id)
    const r = target.reminder
    if (body.action === 'reschedule') {
      target.reminder = { remindAt: body.remind_at, repeat: body.repeat, status: 'scheduled' }
      return clone(target)
    }
    if (!r || r.status === 'cancelled') throw new Error('这条没有进行中的提醒')
    if (body.action === 'done') {
      r.doneAt = new Date().toISOString()
      if (r.repeat === 'none') r.status = 'done'
    } else if (body.action === 'cancel') {
      r.status = 'cancelled'
    } else if (body.action === 'snooze') {
      r.remindAt = new Date(Date.now() + body.minutes * 60_000).toISOString()
      r.status = 'scheduled'
      r.doneAt = undefined
    }
    return clone(target)
  },

  async retryItem(id: string): Promise<void> {
    await latency(80)
    const target = mustGet(id)
    target.processing = { stage: 'organizing' }
    setTimeout(() => {
      const current = items.get(id)
      if (!current || current.partition !== 'inbox') return
      Object.assign(current, {
        partition: 'note',
        title: '下周出差安排（语音转写）',
        summary: '周二去上海，周四返回，需要提前订酒店。',
        tags: ['出差'],
        processing: undefined,
        ai: { model: 'gpt-compatible', at: new Date().toISOString() },
      } satisfies Partial<Item>)
      emit({ type: 'item.classified', item: current })
    }, 1800)
  },

  async listSecrets(): Promise<Secret[]> {
    await latency()
    return clone(secrets)
  },

  /** 演示版：真实实现会在浏览器内用二级密码解开私钥，再逐条解密 */
  async unlockVault(password: string): Promise<Record<string, string>> {
    await latency(700)
    if (!password) throw new Error('请输入二级密码')
    return Object.fromEntries(secretValues)
  },

  subscribe(listener: (e: LiveEvent) => void): () => void {
    listeners.add(listener)
    if (listeners.size === 1) scheduleAuto(1500)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) clearTimeout(autoTimer)
    }
  },

  demo: {
    simulate: simulateIncoming,
    isAuto: () => auto,
    setAuto(on: boolean) {
      auto = on
      scheduleAuto(on ? 1200 : undefined)
    },
  },
}
