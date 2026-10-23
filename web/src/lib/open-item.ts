import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

export const ITEM_PARAM = 'item'

/** 打开条目详情：写入网址参数，手机上按返回键即可关闭 */
export function useOpenItem() {
  const [, setParams] = useSearchParams()
  return useCallback(
    (id: string) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set(ITEM_PARAM, id)
        return next
      }),
    [setParams],
  )
}
