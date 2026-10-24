import type { ComponentProps, CSSProperties } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// 支持 -webkit-text-security 的浏览器用普通文本框加遮罩：不是密码框，浏览器就不会提示保存
const MASKABLE = typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc')
const MASK_STYLE = { WebkitTextSecurity: 'disc' } as CSSProperties

/** 二级密码、恢复码输入框：不让浏览器和密码管理器保存或自动填充 */
export function SecretInput({
  className,
  mask = true,
  ...props
}: ComponentProps<typeof Input> & { mask?: boolean }) {
  return (
    <Input
      {...props}
      type={mask && !MASKABLE ? 'password' : 'text'}
      style={mask && MASKABLE ? MASK_STYLE : undefined}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      className={cn('h-10', className)}
    />
  )
}
