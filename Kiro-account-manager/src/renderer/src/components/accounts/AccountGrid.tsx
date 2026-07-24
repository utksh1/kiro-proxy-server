import { useRef, useMemo, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountCard } from './AccountCard'
import { AccountDetailDialog } from './AccountDetailDialog'
import type { Account } from '@/types/account'
import { Plus } from 'lucide-react'

interface AccountGridProps {
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
}

// Card height (including spacing)- Needs to be large enough to accommodate multiple rewards PRO account
const CARD_HEIGHT = 340
// The minimum width of the card (less than this width, the number of columns will be automatically reduced)
const MIN_CARD_WIDTH = 300
// card spacing
const GAP = 16
// internal px-1 (4px*2 = 8px) Give box-shadow Keep buffer
const PADDING_X = 8

export function AccountGrid({ onAddAccount, onEditAccount }: AccountGridProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [detailAccount, setDetailAccount] = useState<Account | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [columns, setColumns] = useState(3)
  const [cardWidth, setCardWidth] = useState(MIN_CARD_WIDTH)

  // Dynamically calculate the number of columns and card width based on the width of the container (the card adaptively fills the container)
  useEffect(() => {
    const container = parentRef.current
    if (!container) return

    const updateLayout = () => {
      const usableWidth = container.clientWidth - PADDING_X
      // Number of columns: as many as possible, provided that each column is no less than MIN_CARD_WIDTH
      const cols = Math.max(1, Math.floor((usableWidth + GAP) / (MIN_CARD_WIDTH + GAP)))
      // actual card width = Divide the container width equally (minus each gap）
      const newCardWidth = (usableWidth - (cols - 1) * GAP) / cols
      setColumns(cols)
      setCardWidth(newCardWidth)
    }

    updateLayout()

    const resizeObserver = new ResizeObserver(updateLayout)
    resizeObserver.observe(container)

    return () => resizeObserver.disconnect()
  }, [])

  const {
    getFilteredAccounts,
    tags,
    groups,
    selectedIds,
    toggleSelection,
    checkAccountStatus
  } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const handleShowDetail = (account: Account) => {
    setDetailAccount(account)
  }

  const handleRefreshDetail = async () => {
    if (!detailAccount) return
    setIsRefreshing(true)
    try {
      await checkAccountStatus(detailAccount.id)
      // Re-obtain account data after refreshing
      const accounts = getFilteredAccounts()
      const updated = accounts.find(a => a.id === detailAccount.id)
      if (updated) setDetailAccount(updated)
    } finally {
      setIsRefreshing(false)
    }
  }

  const accounts = getFilteredAccounts()

  // Group accounts by rows (include add button as virtual item)
  const rows = useMemo(() => {
    const result: (Account | 'add')[][] = []
    const allItems: (Account | 'add')[] = [...accounts, 'add']
    for (let i = 0; i < allItems.length; i += columns) {
      result.push(allItems.slice(i, i + columns))
    }
    return result
  }, [accounts, columns])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT,
    overscan: 2
  })

  const items = virtualizer.getVirtualItems()

  return (
    <div
      ref={parentRef}
      className="h-full overflow-auto"
      style={{ contain: 'strict' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize() + 8}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {items.map((virtualRow) => {
          const row = rows[virtualRow.index]

          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start + 8}px)` // +8px Leave space for label halo
              }}
            >
              <div className="flex gap-4 items-start px-1">
                {row.map((item) => 
                  item === 'add' ? (
                    <div
                      key="add-button"
                      className="flex items-center justify-center border-2 border-dashed border-muted-foreground/20 rounded-xl cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors flex-shrink-0"
                      style={{ width: cardWidth, height: CARD_HEIGHT - GAP }}
                      onClick={onAddAccount}
                    >
                      <div className="flex flex-col items-center gap-2 text-muted-foreground">
                        <Plus className="h-8 w-8" />
                        <span className="text-sm">{isEn ? 'Add Account' : 'Add account'}</span>
                      </div>
                    </div>
                  ) : (
                    <div key={item.id} className="flex-shrink-0" style={{ width: cardWidth, height: CARD_HEIGHT - GAP }}>
                      <AccountCard
                        account={item}
                        tags={tags}
                        groups={groups}
                        isSelected={selectedIds.has(item.id)}
                        onSelect={() => toggleSelection(item.id)}
                        onEdit={() => onEditAccount(item)}
                        onShowDetail={() => handleShowDetail(item)}
                      />
                    </div>
                  )
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Empty state */}
      {accounts.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-muted-foreground mb-4">{isEn ? 'No accounts yet' : 'No account yet'}</p>
            <button
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={onAddAccount}
            >
              <Plus className="h-4 w-4" />
              {isEn ? 'Add First Account' : 'Add first account'}
            </button>
          </div>
        </div>
      )}

      {/* Account details dialog box */}
      <AccountDetailDialog
        open={!!detailAccount}
        onOpenChange={(open) => !open && setDetailAccount(null)}
        account={detailAccount}
        onRefresh={handleRefreshDetail}
        isRefreshing={isRefreshing}
      />
    </div>
  )
}
