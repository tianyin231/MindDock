import { SearchIcon, SearchXIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useSearch } from '@/api/hooks'
import { EmptyState, PartitionIcon, TagList } from '@/components/common'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { relativeTime } from '@/lib/format'
import { useOpenItem } from '@/lib/open-item'
import { PARTITION } from '@/lib/partitions'

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const [value, setValue] = useState(q)
  const openItem = useOpenItem()

  // 输入停顿 250ms 后更新网址参数并搜索
  useEffect(() => {
    const t = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value.trim()) next.set('q', value.trim())
          else next.delete('q')
          return next
        },
        { replace: true },
      )
    }, 250)
    return () => clearTimeout(t)
  }, [value, setParams])

  const { data, isFetching } = useSearch(q)
  const results = q ? (data ?? []) : []

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="搜索笔记、收藏、待办、提醒和文件"
          className="h-12 rounded-xl pl-10 text-base"
        />
      </div>

      {!q ? (
        <EmptyState icon={SearchIcon} title="搜索全部内容" hint="支持原文、AI 标题与摘要、标签、网站和文件名" />
      ) : isFetching && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <EmptyState icon={SearchXIcon} title={`没有找到「${q}」`} hint="密钥不参与搜索，需在密钥库中查看" />
      ) : (
        <div className="space-y-1">
          <p className="px-1 text-xs text-muted-foreground">{results.length} 条结果</p>
          {results.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => openItem(item.id)}
              className="flex w-full items-start gap-3 rounded-xl p-3 text-left transition-colors hover:bg-muted/60"
            >
              <PartitionIcon partition={item.partition} className="size-9 rounded-lg" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{item.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{PARTITION[item.partition].label}</span>
                </span>
                {item.text && item.text !== item.title && (
                  <span className="line-clamp-1 block text-xs text-muted-foreground">{item.text}</span>
                )}
                <TagList tags={item.tags} />
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(item.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
