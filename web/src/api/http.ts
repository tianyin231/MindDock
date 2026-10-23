/** 与后端通信的最底层封装：同源 Cookie 鉴权，修改类请求带上防 CSRF 的自定义头。 */

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let resp: Response
  try {
    resp = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-MindDock': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, '无法连接服务器，请检查网络')
  }

  const text = await resp.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!resp.ok) {
    const detail = (data as { detail?: unknown } | null)?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : Array.isArray(detail)
          ? '提交的内容格式不正确'
          : `请求失败（HTTP ${resp.status}）`
    throw new ApiError(resp.status, message)
  }
  return data as T
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}
