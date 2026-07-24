import { useState, useEffect } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountToolbar, type AccountViewMode } from './AccountToolbar'
import { AccountGrid } from './AccountGrid'
import { AccountList } from './AccountList'
import { AddAccountDialog } from './AddAccountDialog'
import { EditAccountDialog } from './EditAccountDialog'
import { GroupManageDialog } from './GroupManageDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { Button } from '../ui'
import type { Account } from '@/types/account'
import { splitCredentialLine } from '@/lib/utils'
import { ArrowLeft, Loader2, Users } from 'lucide-react'

interface AccountManagerProps {
  onBack?: () => void
}

export function AccountManager({ onBack }: AccountManagerProps): React.ReactNode {
  const {
    isLoading,
    accounts,
    importFromExportData,
    importAccounts,
    selectedIds,
    activeGroupTab,
    groups
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)
  // View mode:grid(card, default)/ list(compact list), persisted to localStorage
  const [viewMode, setViewMode] = useState<AccountViewMode>(() => {
    const saved = localStorage.getItem('accounts_viewMode')
    return saved === 'list' ? 'list' : 'grid'
  })
  useEffect(() => {
    localStorage.setItem('accounts_viewMode', viewMode)
  }, [viewMode])
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // Get the list of accounts to be exported
  const getExportAccounts = () => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter(acc => selectedIds.has(acc.id))
    }
    return accountList
  }

  // Export
  const handleExport = (): void => {
    setShowExportDialog(true)
  }

  // parse CSV line (handling quotes and commas)
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    result.push(current.trim())
    return result
  }

  // import
  const handleImport = async (): Promise<void> => {
    // file import"Currently open group"（activeGroupTab when it is real grouping), otherwise it is not grouped
    const currentGroupId = (activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)) ? activeGroupTab : undefined
    const groupName = currentGroupId ? (groups.get(currentGroupId)?.name ?? 'Not grouped') : 'Not grouped'
    const fileData = await window.api.importFromFile()

    if (!fileData) return

    const { content, format } = fileData

    try {
      if (format === 'json') {
        // JSON Format: Complete export data
        const data = JSON.parse(content)
        if (data.version && data.accounts) {
          const result = importFromExportData(data)
          const skippedInfo = result.errors.find(e => e.id === 'skipped')
          const skippedMsg = skippedInfo ? `，${skippedInfo.error}` : ''
          alert(`Import completed: successful ${result.success} indivual${skippedMsg}`)
        } else {
          alert('Invalid JSON File format')
        }
      } else if (format === 'csv') {
        // CSV Format: Email,Nick name,Login method,RefreshToken,ClientId,ClientSecret,Region
        const lines = content.split('\n').filter(line => line.trim())
        if (lines.length < 2) {
          alert('CSV The file is empty or has only a header line')
          return
        }

        // Skip header row, parse data row
        const items = lines.slice(1).map(line => {
          const cols = parseCSVLine(line)
          return {
            email: cols[0] || '',
            nickname: cols[1] || undefined,
            idp: cols[2] || 'Google',
            refreshToken: cols[3] || '',
            clientId: cols[4] || '',
            clientSecret: cols[5] || '',
            region: cols[6] || 'us-east-1',
            groupId: currentGroupId
          }
        }).filter(item => item.email && item.refreshToken)

        if (items.length === 0) {
          alert('No valid account data found (requires email and RefreshToken）')
          return
        }

        const result = importAccounts(items)
        alert(`Import completed: successful ${result.success} one, failed ${result.failed} (group:${groupName}）`)
      } else if (format === 'txt') {
        // TXT Format: Automatically identify card password format or common format
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'))

        // Detect whether it is in card encryption format (including ---- separator)
        const isKamiFormat = lines.some(line => line.includes('----'))

        if (isKamiFormat) {
          // Card secret format: email----password----RefreshToken----ClientId----ClientSecret
          // Automatically recognize separators:----、\t, continuous spaces
          const items = lines.map(line => {
            const parts = splitCredentialLine(line)
            const rawPwd = parts[1]?.trim()
            const clientId = parts[3]?.trim() || undefined
            const clientSecret = parts[4]?.trim() || undefined
            // No.6The field is the login method(idp): The new card number will be brought directly; if the old card number does not have this field, press ClientId/Secret infer
            // social(Github/Google) only refreshToken，IdC(BuilderId) only have ClientId/Secret
            const rawIdp = parts[5]?.trim()
            const idp = rawIdp || ((!clientId && !clientSecret) ? 'Google' : 'BuilderId')
            return {
              email: parts[0]?.trim() || '',
              password: (rawPwd && rawPwd !== 'no_password') ? rawPwd : undefined,
              refreshToken: parts[2]?.trim() || '',
              clientId,
              clientSecret,
              idp,
              groupId: currentGroupId
            }
          }).filter(item => item.email && item.refreshToken)

          if (items.length === 0) {
            alert('No valid card secret data found (Format: Email----password----RefreshToken----ClientId----ClientSecret）')
            return
          }

          const result = importAccounts(items)
          alert(`Card secret import completed: Success ${result.success} one, failed ${result.failed} (group:${groupName}）`)
        } else {
          // ordinary TXT Format: Email,RefreshToken or Mail|RefreshToken
          const items = lines.map(line => {
            const parts = line.includes('|') ? line.split('|') : line.split(',')
            return {
              email: parts[0]?.trim() || '',
              refreshToken: parts[1]?.trim() || '',
              nickname: parts[2]?.trim() || undefined,
              idp: parts[3]?.trim() || 'Google',
              groupId: currentGroupId
            }
          }).filter(item => item.email && item.refreshToken)

          if (items.length === 0) {
            alert('No valid account data found (format: email,RefreshToken or Card secret format: email----password----Token----ID----Secret）')
            return
          }

          const result = importAccounts(items)
          alert(`Import completed: successful ${result.success} one, failed ${result.failed} (group:${groupName}）`)
        }
      } else {
        alert(`Unsupported file formats:${format}`)
      }
    } catch (e) {
      console.error('Import error:', e)
      alert('Failed to parse import file')
    }
  }

  // Management grouping
  const handleManageGroups = (): void => {
    setShowGroupDialog(true)
  }

  // Manage tags
  const handleManageTags = (): void => {
    setShowTagDialog(true)
  }

  // Edit account
  const handleEditAccount = (account: Account): void => {
    setEditingAccount(account)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Load account data...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* top toolbar - glassy state (relative z-20 lift stacking context, making sure the dropdown menu floats above the card) */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-3 py-3 glass-toolbar">
        <div className="flex items-center gap-4">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-lg font-semibold text-primary">{isEn ? 'Accounts' : 'Account management'}</h1>
          </div>
        </div>
        
        {/* Toolbar */}
        <AccountToolbar
          onAddAccount={() => setShowAddDialog(true)}
          onImport={handleImport}
          onExport={handleExport}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onManageGroups={handleManageGroups}
          onManageTags={handleManageTags}
          isFilterExpanded={isFilterExpanded}
          onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
        />
      </header>

      {/* main content area */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 py-3 gap-3">
        {/* Account list (card or compact list) */}
        <div className="flex-1 overflow-hidden">
          {viewMode === 'grid' ? (
            <AccountGrid
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          ) : (
            <AccountList
              onAddAccount={() => setShowAddDialog(true)}
              onEditAccount={handleEditAccount}
            />
          )}
        </div>
      </div>

      {/* Add account dialog box */}
      <AddAccountDialog
        isOpen={showAddDialog}
        onClose={() => setShowAddDialog(false)}
      />

      {/* Edit account dialog box */}
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* Group management dialog box */}
      <GroupManageDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
      />

      {/* Tag management dialog */}
      <TagManageDialog
        isOpen={showTagDialog}
        onClose={() => setShowTagDialog(false)}
      />

      {/* Export dialog */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
      />
    </div>
  )
}
