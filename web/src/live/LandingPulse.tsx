import { motion } from 'motion/react'
import type { PartitionKey } from '@/api/types'
import { partitionTone } from '@/lib/partitions'
import { useBump } from './live'

/** 分区落点在有内容落地时亮起一圈光晕；放在 relative 元素里 */
export function LandingPulse({ partition }: { partition: PartitionKey }) {
  const bump = useBump(partition)
  if (bump === 0) return null
  const color = partitionTone(partition)
  return (
    <motion.span
      key={bump}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 rounded-[inherit]"
      style={{ boxShadow: `inset 0 0 0 1.5px ${color}, 0 0 28px -6px ${color}` }}
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 1, ease: 'easeOut' }}
    />
  )
}
