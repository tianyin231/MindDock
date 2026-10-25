/**
 * 内存版后端：在接入真实接口之前，用来驱动整个前端和归类动画。
 * 行为对齐设计文档：新消息先进"处理中"，AI 归类后进入分区；密钥在收件时直接分流。
 */
import type {
  Counts,
  Item,
  ItemPartition,
  LiveEvent,
  ReminderAction,
  Secret,
  TimelineEntry,
  TimelinePage,
  VaultKeysData,
  VaultRewrapBody,
  VaultSetupBody,
} from '../types'
import { INCOMING, makeCode, makeId, seedItems, seedSecrets } from './seed'

const items = new Map<string, Item>(seedItems().map((i) => [i.id, i]))

// 密钥库：和真实后端一样只保存公钥、包裹后的私钥和密文，加解密都在页面里完成。
// 演示开始时尚未启用；启用后把示例密钥加密存入，相当于此前收到的消息
let vault: VaultKeysData | null = null
const secrets: Secret[] = []
const challenges = new Map<string, string>()

async function sealForVault(value: string): Promise<string> {
  const crypto = await import('@/lib/vault-crypto')
  await crypto.ready()
  return crypto.sealText(value, crypto.fromB64(vault!.publicKey))
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
    // 密钥在收件阶段就被识别并加密，不经过 AI；密钥库未启用时不保存
    const { label, value } = tpl.secret
    if (vault) {
      void sealForVault(value).then((sealed) => {
        const secret: Secret = { id: makeId(), code: makeCode(), label, kind: 'text', createdAt: now, sealed }
        secrets.unshift(secret)
        emit({ type: 'secret.stored', secret })
      })
    }
    return
  }

  receive(tpl.preview, tpl.result!, 'qq')
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

// ---- 面板投递：用几条简单规则代替 AI，好让演示走完整个流程 ----

function guessResult(text: string): Partial<Item> {
  const url = text.match(/https?:\/\/[^\s]+/)?.[0]
  const rest = text.replace(url ?? '', '').trim()
  const title = (rest || text).split('\n')[0].slice(0, 24)
  if (url) {
    const site = new URL(url).hostname.replace(/^www\./, '')
    return { partition: 'bookmark', title: rest ? title : site, link: { url, site, title: title || site }, tags: ['链接'] }
  }
  if (/提醒|闹钟|叫我/.test(text)) {
    const at = new Date(Date.now() + 3 * HOUR_MS)
    at.setMinutes(0, 0, 0)
    return { partition: 'reminder', title, reminder: { remindAt: at.toISOString(), repeat: 'none', status: 'scheduled' } }
  }
  if (/记得|要|得|买|交|之前|完成/.test(text)) return { partition: 'todo', title, todo: {} }
  return { partition: 'note', title, summary: text.length > 24 ? text.slice(0, 60) : undefined }
}

const HOUR_MS = 3_600_000

function receive(text: string, result: Partial<Item>, source: Item['source']): Item {
  const fresh: Item = {
    id: makeId(),
    code: makeCode(),
    source,
    partition: 'inbox',
    partitionSource: 'auto',
    text,
    title: text,
    tags: [],
    createdAt: new Date().toISOString(),
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
    1800 + Math.random() * 900,
  )
  return fresh
}

const entryKey = (e: TimelineEntry) =>
  e.kind === 'item' ? `${e.item.createdAt}|${e.item.id}` : `${e.secret.createdAt}|${e.secret.id}`

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

  async timeline(before?: string): Promise<TimelinePage> {
    await latency()
    const all: TimelineEntry[] = [
      ...[...items.values()].map((item) => ({ kind: 'item' as const, item })),
      ...secrets.map((secret) => ({ kind: 'secret' as const, secret })),
    ].sort((a, b) => (entryKey(a) < entryKey(b) ? 1 : -1))
    const rest = before ? all.filter((e) => entryKey(e) < before) : all
    const page = rest.slice(0, 20)
    return clone({ entries: page, next: rest.length > page.length ? entryKey(page[page.length - 1]) : null })
  },

  async addText(text: string): Promise<TimelineEntry> {
    await latency(80)
    const body = text.trim()
    const explicit = body.match(/^#key\s*(.*)$/is)
    if (explicit) {
      if (!vault) throw new Error('这条内容带有 #key 标记，按密钥处理，但密钥库还没启用，没有保存')
      const [label, ...value] = explicit[1].split('\n')
      const secret: Secret = {
        id: makeId(),
        code: makeCode(),
        label: label.trim() || '未命名密钥',
        kind: 'text',
        createdAt: new Date().toISOString(),
        source: 'panel',
        sealed: await sealForVault(value.join('\n') || label),
      }
      secrets.unshift(secret)
      emit({ type: 'secret.stored', secret })
      return clone({ kind: 'secret', secret })
    }
    return clone({ kind: 'item', item: receive(body, guessResult(body), 'panel') })
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

  async vaultState() {
    await latency()
    return { initialized: vault !== null, publicKey: vault?.publicKey ?? null }
  },

  async vaultSetup(body: VaultSetupBody) {
    await latency(200)
    if (vault) throw new Error('密钥库已经启用过了')
    vault = { publicKey: body.public_key, password: body.password, recovery: body.recovery }
    for (const { secret, value } of seedSecrets()) secrets.push({ ...secret, sealed: await sealForVault(value) })
    return { initialized: true, publicKey: vault.publicKey }
  },

  async vaultKeys() {
    await latency()
    if (!vault) throw new Error('密钥库尚未启用')
    return clone(vault)
  },

  async vaultChallenge() {
    await latency()
    const token = makeId()
    const answer = makeId()
    challenges.set(token, btoa(answer))
    return { token, sealed: await sealForVault(answer) }
  },

  async vaultRewrap(body: VaultRewrapBody) {
    await latency(200)
    const expected = challenges.get(body.token)
    challenges.delete(body.token)
    if (!vault || expected !== body.answer) throw new Error('验证失败，请重新解锁后再试')
    vault.password = body.password
    if (body.recovery) vault.recovery = body.recovery
  },

  async listSecrets(): Promise<Secret[]> {
    await latency()
    return clone(secrets)
  },

  async secretBlob(): Promise<Uint8Array> {
    throw new Error('演示数据里没有附件类密钥')
  },

  async addSecret(label: string, sealed: string): Promise<Secret> {
    await latency(80)
    const secret: Secret = { id: makeId(), code: makeCode(), label, kind: 'text', createdAt: new Date().toISOString(), source: 'panel', sealed }
    secrets.unshift(secret)
    return clone(secret)
  },

  async deleteSecret(id: string): Promise<void> {
    await latency(80)
    const index = secrets.findIndex((x) => x.id === id)
    if (index >= 0) secrets.splice(index, 1)
  },

  async releaseSecret(id: string, text: string): Promise<Item> {
    await latency(80)
    const index = secrets.findIndex((x) => x.id === id)
    if (index >= 0) secrets.splice(index, 1)
    const title = text.split('\n')[0].slice(0, 40)
    const created: Item = {
      id: makeId(),
      code: makeCode(),
      source: 'panel',
      partition: 'note',
      partitionSource: 'auto',
      text,
      title,
      tags: [],
      createdAt: new Date().toISOString(),
      attachments: [],
    }
    items.set(created.id, created)
    return clone(created)
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
