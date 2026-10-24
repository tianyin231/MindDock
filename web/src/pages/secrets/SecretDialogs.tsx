import { DownloadIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { VaultKeys } from '@/lib/vault-crypto'
import { errorText, nextFrame, type VaultCrypto } from './crypto'
import { SecretInput } from './SecretInput'

interface VaultDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  keys: VaultKeys
  crypto: VaultCrypto
}

/** 在面板里新增：浏览器内用公钥加密后再提交 */
export function AddSecretDialog({ open, onOpenChange, keys, crypto, onAdded }: VaultDialogProps & { onAdded: () => void }) {
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!label.trim() || !value) return
    setBusy(true)
    try {
      await api.addSecret(label.trim(), crypto.sealText(value, keys.publicKey))
      toast.success('已加密保存')
      setLabel('')
      setValue('')
      onAdded()
      onOpenChange(false)
    } catch (err) {
      toast.error(errorText(err, '保存失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>添加密钥</DialogTitle>
            <DialogDescription>内容在浏览器里加密后才发送，服务器只保存密文；名称不加密</DialogDescription>
          </DialogHeader>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名称，如：家里 Wi-Fi" maxLength={60} aria-label="名称" />
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="内容"
            aria-label="内容"
            rows={4}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
          <DialogFooter>
            <Button type="submit" disabled={busy || !label.trim() || !value}>
              {busy ? '加密中…' : '加密保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 修改二级密码：用内存里的私钥重新包裹，并解开服务器的挑战证明持有私钥 */
export function ChangePasswordDialog({ open, onOpenChange, keys, crypto }: VaultDialogProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return setError('请输入新的二级密码')
    if (password !== confirm) return setError('两次输入的二级密码不一致')
    setBusy(true)
    setError('')
    try {
      await nextFrame()
      const wrap = crypto.wrapKey(keys.privateKey, password)
      const challenge = await api.vaultChallenge()
      await api.vaultRewrap({ token: challenge.token, answer: crypto.answerChallenge(challenge.sealed, keys), password: wrap })
      toast.success('二级密码已修改')
      setPassword('')
      setConfirm('')
      onOpenChange(false)
    } catch (err) {
      setError(errorText(err, '修改失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>修改二级密码</DialogTitle>
            <DialogDescription>已存的密钥不用重新加密；恢复码保持不变</DialogDescription>
          </DialogHeader>
          <SecretInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="新的二级密码"
            aria-label="新的二级密码"
          />
          <SecretInput value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="再输入一次" aria-label="确认新的二级密码" />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy ? '处理中…' : '修改'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export interface DecryptedFile {
  url: string
  name: string
  mime: string
}

/** 附件类密钥解密后的预览（图片）与下载，关闭时释放内存里的明文 */
export function FilePreviewDialog({ file, onClose }: { file: DecryptedFile | null; onClose: () => void }) {
  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{file?.name}</DialogTitle>
          <DialogDescription>已在浏览器内解密，关闭后释放</DialogDescription>
        </DialogHeader>
        {file?.mime.startsWith('image/') && (
          <img src={file.url} alt={file.name} className="max-h-[70vh] w-full rounded-lg object-contain" />
        )}
        <DialogFooter>
          <Button asChild variant="outline">
            <a href={file?.url} download={file?.name}>
              <DownloadIcon />
              下载
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
