import { motion, useSpring, useTransform } from 'motion/react'
import { useEffect, useId, type ComponentType, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { PartitionKey } from '@/api/types'
import { PARTITION } from '@/lib/partitions'

export function Logo({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <rect x="8" y="9" width="16" height="3.2" rx="1.6" fill="#fff" />
      <rect x="8" y="14.4" width="11" height="3.2" rx="1.6" fill="#fff" opacity=".8" />
      <rect x="8" y="19.8" width="13.5" height="3.2" rx="1.6" fill="#fff" opacity=".6" />
    </svg>
  )
}

/** 数字变化时平滑滚动；首次出现时从 0 数上来 */
export function AnimatedCount({ value, className }: { value: number; className?: string }) {
  const spring = useSpring(0, { stiffness: 110, damping: 20, mass: 0.8 })
  const text = useTransform(spring, (v) => Math.round(v).toLocaleString('zh-CN'))
  useEffect(() => {
    spring.set(value)
  }, [spring, value])
  return <motion.span className={cn('tabular-nums', className)}>{text}</motion.span>
}

export function PartitionIcon({
  partition,
  className,
  iconClassName,
}: {
  partition: PartitionKey
  className?: string
  iconClassName?: string
}) {
  const meta = PARTITION[partition]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex shrink-0 items-center justify-center rounded-lg', meta.soft, meta.text, className)}>
      <Icon className={cn('size-4', iconClassName)} />
    </span>
  )
}

export function PartitionBadge({ partition, className }: { partition: PartitionKey; className?: string }) {
  const meta = PARTITION[partition]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium',
        meta.soft,
        meta.text,
        className,
      )}
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  )
}

export function TagList({ tags, className }: { tags: string[]; className?: string }) {
  if (tags.length === 0) return null
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {tags.map((t) => (
        <span key={t} className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
          #{t}
        </span>
      ))}
    </div>
  )
}

export function SectionHeader({
  title,
  icon: Icon,
  action,
  className,
}: {
  title: string
  icon?: ComponentType<{ className?: string }>
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {Icon && <Icon className="size-4 text-muted-foreground" />}
        {title}
      </h2>
      {action}
    </div>
  )
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  className,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  hint?: string
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-10 text-center', className)}>
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-xs text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function PageHeader({
  partition,
  count,
  actions,
}: {
  partition: PartitionKey
  count?: number
  actions?: ReactNode
}) {
  const meta = PARTITION[partition]
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <PartitionIcon partition={partition} className="size-11 rounded-xl" iconClassName="size-5" />
        <div>
          <h1 className="flex items-baseline gap-2 text-xl font-semibold tracking-tight">
            {meta.label}
            {count !== undefined && <span className="text-sm font-normal text-muted-foreground">{count}</span>}
          </h1>
          <p className="text-sm text-muted-foreground">{meta.description}</p>
        </div>
      </div>
      {actions}
    </div>
  )
}
