import { useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountListRow } from './AccountListRow'
import { AccountDetailDialog } from './AccountDetailDialog'
import type { Account } from '@/types/account'
import { Plus } from 'lucide-react'

interface AccountListProps {
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
}

// List row height (compact, aligned card visual details)
const ROW_HEIGHT = 72
// line spacing (for active-glow-border and box-shadow Leave breathing room)
const ROW_GAP = 10

export function AccountList({ onAddAccount, onEditAccount }: AccountListProps): React.ReactNode {
  const parentRef = useRef<HTMLDivElement>(null)
  const [detailAccount, setDetailAccount] = useState<Account | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const {
    getFilteredAccounts,
    tags,
    groups,
    selectedIds,
    checkAccountStatus
  } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const accounts = getFilteredAccounts()

  const handleShowDetail = (account: Account) => {
    setDetailAccount(account)
  }

  const handleRefreshDetail = async () => {
    if (!detailAccount) return
    setIsRefreshing(true)
    try {
      await checkAccountStatus(detailAccount.id)
      const updated = getFilteredAccounts().find(a => a.id === detailAccount.id)
      if (updated) setDetailAccount(updated)
    } finally {
      setIsRefreshing(false)
    }
  }

  // Virtual list (each item has a row height + spacing)
  const virtualizer = useVirtualizer({
    count: accounts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT + ROW_GAP,
    overscan: 8
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
          height: `${virtualizer.getTotalSize() + 80}px`,
          width: '100%',
          position: 'relative'
        }}
      >
        {items.map((virtualRow) => {
          const account = accounts[virtualRow.index]
          if (!account) return null
          return (
            <div
              key={virtualRow.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${ROW_HEIGHT}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <AccountListRow
                account={account}
                tags={tags}
                groups={groups}
                isSelected={selectedIds.has(account.id)}
                onEdit={() => onEditAccount(account)}
                onShowDetail={() => handleShowDetail(account)}
              />
            </div>
          )
        })}

        {/* "Add Account" button at the bottom of the list */}
        {accounts.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: `${virtualizer.getTotalSize()}px`,
              left: 0,
              width: '100%'
            }}
          >
            <button
              type="button"
              onClick={onAddAccount}
              className="w-full flex items-center justify-center gap-2 py-3 border-2 border-dashed border-muted-foreground/20 rounded-lg text-muted-foreground hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-colors"
            >
              <Plus className="h-4 w-4" />
              <span className="text-sm">{isEn ? 'Add Account' : 'Add account'}</span>
            </button>
          </div>
        )}
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
