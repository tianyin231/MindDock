export type VaultCrypto = typeof import('@/lib/vault-crypto')

export const MIN_VAULT_PASSWORD = 10

let loading: Promise<VaultCrypto> | null = null

/** libsodium 体积较大，第一次用到时才加载 */
export function loadCrypto(): Promise<VaultCrypto> {
  loading ??= import('@/lib/vault-crypto')
    .then(async (mod) => {
      await mod.ready()
      return mod
    })
    .catch((err) => {
      loading = null
      throw err
    })
  return loading
}

/** Argon2id 会占用主线程约 1 秒，先让出一帧，让"处理中"的状态先显示出来 */
export const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 40))

export function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback
}

/** 二级密码或恢复码不对（解包失败） */
export function isWrongSecret(err: unknown): boolean {
  return err instanceof Error && err.name === 'WrongSecretError'
}
