import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { http } from '@/api/http'

export interface AuthState {
  setup_required: boolean
  authenticated: boolean
  username: string | null
}

export type LoginResult = { status: 'ok' } | { status: 'totp_required'; challenge: string }

export interface SetupStarted {
  setup_token: string
  totp_secret: string
  totp_uri: string
  /** 二维码图片的 data URI */
  totp_qr: string
}

export const authKey = ['auth'] as const

export function useAuthState() {
  return useQuery({
    queryKey: authKey,
    queryFn: () => http.get<AuthState>('/api/auth/state'),
    staleTime: 60_000,
    retry: false,
  })
}

export const authApi = {
  login: (username: string, password: string) => http.post<LoginResult>('/api/auth/login', { username, password }),
  loginTotp: (challenge: string, code: string, trustDevice: boolean) =>
    http.post<{ status: 'ok' }>('/api/auth/login/totp', { challenge, code, trust_device: trustDevice }),
  setupStart: (setupCode: string, username: string, password: string) =>
    http.post<SetupStarted>('/api/auth/setup/start', { setup_code: setupCode, username, password }),
  setupFinish: (setupToken: string, code: string) =>
    http.post<{ status: 'ok' }>('/api/auth/setup/finish', { setup_token: setupToken, code }),
}

export function useLogout() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: () => http.post('/api/auth/logout'),
    onSettled: () => {
      qc.clear()
      navigate('/login', { replace: true })
    },
  })
}
