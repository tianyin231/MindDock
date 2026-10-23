import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { Counts, Item, ItemPartition } from './types'

export const qk = {
  counts: ['counts'] as const,
  items: (partition: ItemPartition) => ['items', partition] as const,
  item: (id: string) => ['item', id] as const,
  search: (q: string) => ['search', q] as const,
  secrets: ['secrets'] as const,
}

export function useCounts() {
  return useQuery({ queryKey: qk.counts, queryFn: () => api.counts() })
}

export function useItems(partition: ItemPartition) {
  return useQuery({ queryKey: qk.items(partition), queryFn: () => api.listItems(partition) })
}

export function useItem(id: string | null) {
  return useQuery({
    queryKey: qk.item(id ?? ''),
    queryFn: () => api.getItem(id!),
    enabled: Boolean(id),
  })
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: qk.search(q.trim()),
    queryFn: () => api.search(q),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  })
}

export function useSecrets() {
  return useQuery({ queryKey: qk.secrets, queryFn: () => api.listSecrets() })
}

export function useToggleTodo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => api.setTodoDone(id, done),
    // 乐观更新：勾选立即生效，失败时回滚
    onMutate: async ({ id, done }) => {
      await qc.cancelQueries({ queryKey: qk.items('todo') })
      const previous = qc.getQueryData<Item[]>(qk.items('todo'))
      qc.setQueryData<Item[]>(qk.items('todo'), (list) =>
        list?.map((i) =>
          i.id === id ? { ...i, todo: { ...i.todo, doneAt: done ? new Date().toISOString() : undefined } } : i,
        ),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => qc.setQueryData(qk.items('todo'), ctx?.previous),
    onSettled: (_data, _err, { id }) => {
      qc.invalidateQueries({ queryKey: qk.items('todo') })
      qc.invalidateQueries({ queryKey: qk.item(id) })
    },
  })
}

export function useAddTodo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (title: string) => api.addTodo(title),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.items('todo') })
      qc.setQueryData<Counts>(qk.counts, (c) => (c ? { ...c, todo: c.todo + 1 } : c))
    },
  })
}

export function useMoveItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, partition }: { id: string; partition: ItemPartition }) => api.moveItem(id, partition),
    onSuccess: (item) => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: qk.counts })
      qc.setQueryData(qk.item(item.id), item)
    },
  })
}

export function useRetryItem() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.retryItem(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.items('inbox') }),
  })
}
