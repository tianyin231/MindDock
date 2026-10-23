import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { http } from './http'

export type FieldKind = 'text' | 'secret' | 'number' | 'bool'

export interface SettingField {
  key: string
  label: string
  kind: FieldKind
  required: boolean
  placeholder: string
  help: string
}

export interface SecretValue {
  set: boolean
  hint: string
}

export interface SettingSection {
  key: string
  title: string
  description: string
  fields: SettingField[]
  values: Record<string, string | number | boolean | null | SecretValue>
  configured: boolean
  updated_at: string | null
}

export interface TestResult {
  ok: boolean
  message: string
  details: Record<string, unknown>
}

export interface Health {
  status: string
  version: string
  build: string
  commit: string
  schema: number
}

const settingsKey = ['settings'] as const

export function useSettings() {
  return useQuery({
    queryKey: settingsKey,
    queryFn: async () => (await http.get<{ sections: SettingSection[] }>('/api/settings')).sections,
  })
}

export function useSaveSection(section: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (values: Record<string, unknown>) => http.put<SettingSection>(`/api/settings/${section}`, { values }),
    onSuccess: (saved) =>
      qc.setQueryData<SettingSection[]>(settingsKey, (list) => list?.map((s) => (s.key === saved.key ? saved : s))),
  })
}

export function useTestSection(section: string) {
  return useMutation({
    mutationFn: () => http.post<TestResult>(`/api/settings/${section}/test`),
  })
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => http.get<Health>('/api/health'), staleTime: Infinity })
}
