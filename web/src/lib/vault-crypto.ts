/**
 * 密钥库的浏览器端加解密（libsodium）。体积较大，只在密钥页按需加载。
 *
 * - X25519 密钥对：服务器拿公钥加密（sealed box），私钥只在浏览器内存里解开使用
 * - 私钥用 Argon2id(二级密码) 和 Argon2id(恢复码) 派生的密钥各包裹一份：nonce(24) + secretbox
 * - 服务器从不接触二级密码、恢复码和明文私钥
 */
import sodium from 'libsodium-wrappers-sumo'

export interface KdfParams {
  alg: 'argon2id13'
  ops: number
  mem: number
}

/** 一份包裹后的私钥，与后端 /api/vault 的格式一致（Base64） */
export interface Wrap {
  wrapped: string
  salt: string
  params: KdfParams
}

/** 解锁后的钥匙，只放在内存里；锁定时用 forget 清零 */
export interface VaultKeys {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

/** Argon2id 参数：64 MiB、3 轮，手机浏览器上约 1 秒 */
export const DEFAULT_PARAMS: KdfParams = { alg: 'argon2id13', ops: 3, mem: 64 * 1024 * 1024 }

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const NONCE_BYTES = 24

export class WrongSecretError extends Error {
  override name = 'WrongSecretError'

  constructor() {
    super('二级密码或恢复码不正确')
  }
}

export async function ready(): Promise<void> {
  await sodium.ready
}

const variant = () => sodium.base64_variants.ORIGINAL
export const toB64 = (data: Uint8Array) => sodium.to_base64(data, variant())
export const fromB64 = (text: string) => sodium.from_base64(text, variant())

function deriveKey(secret: string, salt: Uint8Array, p: KdfParams): Uint8Array {
  return sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    secret,
    salt,
    p.ops,
    p.mem,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
}

export function wrapKey(privateKey: Uint8Array, secret: string, params = DEFAULT_PARAMS): Wrap {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES)
  const key = deriveKey(secret, salt, params)
  const nonce = sodium.randombytes_buf(NONCE_BYTES)
  const box = sodium.crypto_secretbox_easy(privateKey, nonce, key)
  sodium.memzero(key)
  const wrapped = new Uint8Array(NONCE_BYTES + box.length)
  wrapped.set(nonce)
  wrapped.set(box, NONCE_BYTES)
  return { wrapped: toB64(wrapped), salt: toB64(salt), params }
}

export function unwrapKey(wrap: Wrap, secret: string): Uint8Array {
  const data = fromB64(wrap.wrapped)
  const key = deriveKey(secret, fromB64(wrap.salt), wrap.params)
  try {
    return sodium.crypto_secretbox_open_easy(data.subarray(NONCE_BYTES), data.subarray(0, NONCE_BYTES), key)
  } catch {
    throw new WrongSecretError()
  } finally {
    sodium.memzero(key)
  }
}

/** 恢复码：160 位随机数，Crockford Base32，每 4 位一组，例如 7K2Q-…（共 8 组） */
export function newRecoveryCode(): string {
  const bytes = sodium.randombytes_buf(20)
  let value = 0
  let bits = 0
  let out = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out.match(/.{4}/g)!.join('-')
}

/** 输入时忽略大小写、空格和横线，容忍 O/0、I/L/1 混淆 */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
}

export function looksLikeRecoveryCode(input: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(normalizeRecoveryCode(input))
}

/** 启用密钥库：生成密钥对和恢复码，返回提交给服务器的数据 */
export function createVault(password: string) {
  const pair = sodium.crypto_box_keypair()
  const recoveryCode = newRecoveryCode()
  const body = {
    public_key: toB64(pair.publicKey),
    password: wrapKey(pair.privateKey, password),
    recovery: wrapKey(pair.privateKey, normalizeRecoveryCode(recoveryCode)),
  }
  sodium.memzero(pair.privateKey)
  return { body, recoveryCode }
}

export function forget(keys: VaultKeys): void {
  sodium.memzero(keys.privateKey)
}

export function openText(sealed: string, keys: VaultKeys): string {
  return sodium.crypto_box_seal_open(fromB64(sealed), keys.publicKey, keys.privateKey, 'text')
}

export function openBytes(sealed: Uint8Array, keys: VaultKeys): Uint8Array {
  return sodium.crypto_box_seal_open(sealed, keys.publicKey, keys.privateKey)
}

export function sealText(text: string, publicKey: Uint8Array): string {
  return toB64(sodium.crypto_box_seal(text, publicKey))
}

/** 解开服务器的挑战，证明持有私钥（修改二级密码时使用） */
export function answerChallenge(sealed: string, keys: VaultKeys): string {
  return toB64(sodium.crypto_box_seal_open(fromB64(sealed), keys.publicKey, keys.privateKey))
}
