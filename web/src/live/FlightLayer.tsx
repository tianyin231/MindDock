import { motion } from 'motion/react'
import { createPortal } from 'react-dom'
import { PARTITION, partitionTone } from '@/lib/partitions'
import { cn } from '@/lib/utils'
import { FLIGHT_MS, type Flight } from './live'

const TRAIL = [0.05, 0.1, 0.15]

/** 飞行中的分区标签：固定定位在视口上，沿一条向上拱起的弧线飞向落点，身后拖着几粒光点 */
export function FlightLayer({ flights }: { flights: Flight[] }) {
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-[60]">
      {flights.map((f) => (
        <FlightPath key={f.id} flight={f} />
      ))}
    </div>,
    document.body,
  )
}

function path(f: Flight) {
  const fx = f.from.left + f.from.width / 2
  const fy = f.from.top + f.from.height / 2
  const dx = f.to.left + f.to.width / 2 - fx
  const dy = f.to.top + f.to.height / 2 - fy
  // 弧顶比起点和终点都高一些，距离越远拱得越高；但不能飞出视口（比如从顶栏起飞时）
  const lift = Math.min(140, 40 + Math.hypot(dx, dy) * 0.18)
  const peak = Math.max(24, Math.min(fy, fy + dy) - lift)
  return { fx, fy, x: [0, dx * 0.5, dx], y: [0, peak - fy, dy] }
}

function FlightPath({ flight }: { flight: Flight }) {
  const meta = PARTITION[flight.partition]
  const Icon = meta.icon
  const { fx, fy, x, y } = path(flight)
  const duration = FLIGHT_MS / 1000
  const motionPath = {
    x,
    y,
    transition: {
      duration,
      times: [0, 0.45, 1],
      x: { duration, times: [0, 0.45, 1], ease: ['easeIn', 'easeOut'] },
      y: { duration, times: [0, 0.45, 1], ease: ['easeOut', 'easeIn'] },
    },
  }

  return (
    <div className="absolute" style={{ left: fx, top: fy }}>
      {TRAIL.map((delay, i) => (
        <motion.span
          key={delay}
          className="absolute -top-1 -left-1 size-2 rounded-full blur-[1px]"
          style={{ background: partitionTone(flight.partition) }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 1 }}
          animate={{
            x,
            y,
            opacity: [0, 0.7 - i * 0.18, 0],
            scale: [1, 0.9 - i * 0.15, 0.3],
            transition: {
              x: { duration, delay, times: [0, 0.45, 1], ease: ['easeIn', 'easeOut'] },
              y: { duration, delay, times: [0, 0.45, 1], ease: ['easeOut', 'easeIn'] },
              opacity: { duration, delay },
              scale: { duration, delay },
            },
          }}
        />
      ))}
      <motion.div
        style={{ originX: 0, originY: 0 }}
        initial={{ x: 0, y: 0, scale: 0.6, opacity: 0 }}
        animate={{
          ...motionPath,
          scale: [0.9, 1.08, 0.5],
          opacity: [1, 1, 0],
          transition: {
            ...motionPath.transition,
            scale: { duration, times: [0, 0.4, 1] },
            opacity: { duration: duration + 0.15, times: [0, 0.85, 1] },
          },
        }}
      >
        <div
          className={cn(
            'flex h-7 max-w-44 -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap text-white',
            meta.solid,
          )}
          style={{
            boxShadow: `0 0 0 1px oklch(1 0 0 / 0.25) inset, 0 8px 24px -6px ${partitionTone(flight.partition)}`,
          }}
        >
          <Icon className="size-3.5 shrink-0" />
          <span className="truncate">{flight.title}</span>
        </div>
      </motion.div>
    </div>
  )
}
