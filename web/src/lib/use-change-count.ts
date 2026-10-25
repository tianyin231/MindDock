import { useState } from 'react'

/** 值每变化一次计数加一（首次渲染为 0），用作重播"变化动画"的 key */
export function useChangeCount<T>(value: T): number {
  const [prev, setPrev] = useState(value)
  const [count, setCount] = useState(0)
  if (!Object.is(prev, value)) {
    setPrev(value)
    setCount(count + 1)
  }
  return count
}
