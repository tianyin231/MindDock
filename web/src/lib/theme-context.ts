import { createContext, use } from 'react'

export type Theme = 'light' | 'dark' | 'system'

/** 与 public/theme-init.js 使用同一个键 */
export const THEME_STORAGE_KEY = 'minddock-theme'

export interface ThemeValue {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme(theme: Theme): void
}

export const ThemeContext = createContext<ThemeValue | null>(null)

export function useTheme(): ThemeValue {
  const value = use(ThemeContext)
  if (!value) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return value
}
