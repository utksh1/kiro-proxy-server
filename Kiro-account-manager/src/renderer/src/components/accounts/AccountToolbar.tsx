import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { Button, Badge } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountFilterPanel } from './AccountFilter'
import { toRgba } from './_helpers'
import { cn } from '@/lib/utils'
import { Network as NetworkIcon, Link2 as Link2Icon, Unlink as UnlinkIcon } from 'lucide-react'
import {
  Search,
  Plus,
  Upload,
  Download,
  Trash2,
  Tag,
  FolderPlus,
  CheckSquare,
  Square,
  Loader2,
  Eye,
  EyeOff,
  Filter,
  ChevronDown,
  Check,
  X,
  Minus,
  LayoutGrid,
  List as ListIcon,
  Users,
  Inbox,
  ArrowRightLeft,
  Zap,
  Activity,
  KeyRound
} from 'lucide-react'

export type AccountViewMode = 'grid' | 'list'

interface AccountToolbarProps {
  onAddAccount: () => void
  onImport: () => void
  onExport: () => void
  viewMode: AccountViewMode
  onViewModeChange: (mode: AccountViewMode) => void
  onManageGroups: () => void
  onManageTags: () => void
  isFilterExpanded: boolean
  onToggleFilter: () => void
}

export function AccountToolbar({
  onAddAccount,
  onImport,
  onExport,
  viewMode,
  onViewModeChange,
  onManageGroups,
  onManageTags,
  isFilterExpanded,
  onToggleFilter
}: AccountToolbarProps): React.ReactNode {
  const {
    filter,
    setFilter,
    selectedIds,
    selectAll,
    deselectAll,
    removeAccounts,
    batchRefreshTokens,
    batchCheckStatus,
    getFilteredAccounts,
    getStats,
    privacyMode,
    setPrivacyMode,
    groups,
    tags,
    accounts,
    moveAccountsToGroup,
    addTagToAccounts,
    removeTagFromAccounts,
    activeGroupTab,
    setActiveGroupTab,
    proxyPool,
    accountProxyBindings,
    bindAccountsToProxy,
    unbindAccountFromProxy
  } = useAccountsStore()

  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isChecking, setIsChecking] = useState(false)
  const [showGroupMenu, setShowGroupMenu] = useState(false)
  const [showTagMenu, setShowTagMenu] = useState(false)
  const [showProxyMenu, setShowProxyMenu] = useState(false)

  const groupMenuRef = useRef<HTMLDivElement>(null)
  const tagMenuRef = useRef<HTMLDivElement>(null)
  const proxyMenuRef = useRef<HTMLDivElement>(null)
  
  // Click outside to close menu
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setShowGroupMenu(false)
      }
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) {
        setShowTagMenu(false)
      }
      if (proxyMenuRef.current && !proxyMenuRef.current.contains(e.target as Node)) {
        setShowProxyMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // The selected account has been bound to the statistics of each agent
  const getSelectedProxyBindingStatus = useCallback(() => {
    const selectedAccs = Array.from(selectedIds).map((id) => accounts.get(id)).filter(Boolean)
    const proxyCounts = new Map<string | 'none', number>()
    selectedAccs.forEach((acc) => {
      if (!acc) return
      const pid = accountProxyBindings[acc.id]
      const key = pid || 'none'
      proxyCounts.set(key, (proxyCounts.get(key) || 0) + 1)
    })
    return { selectedAccs, proxyCounts, total: selectedAccs.length }
  }, [selectedIds, accounts, accountProxyBindings])

  const handleBindToProxy = (proxyId: string): void => {
    if (selectedIds.size === 0) return
    bindAccountsToProxy(Array.from(selectedIds), proxyId)
    setShowProxyMenu(false)
  }

  const handleUnbindAllSelected = (): void => {
    if (selectedIds.size === 0) return
    for (const id of selectedIds) {
      unbindAccountFromProxy(id)
    }
    setShowProxyMenu(false)
  }
  
  // Get the group status of the selected account (useMemo Caching to avoid recalculation for each rendering O(N)）
  const selectedGroupStatus = useMemo(() => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const groupCounts = new Map<string | undefined, number>()
    selectedAccounts.forEach(acc => {
      if (acc) {
        const gid = acc.groupId
        groupCounts.set(gid, (groupCounts.get(gid) || 0) + 1)
      }
    })
    return { selectedAccounts, groupCounts }
  }, [selectedIds, accounts])

  const selectedTagStatus = useMemo(() => {
    const selectedAccounts = Array.from(selectedIds).map(id => accounts.get(id)).filter(Boolean)
    const tagCounts = new Map<string, number>()
    selectedAccounts.forEach(acc => {
      if (acc?.tags) {
        acc.tags.forEach(tagId => {
          tagCounts.set(tagId, (tagCounts.get(tagId) || 0) + 1)
        })
      }
    })
    return { selectedAccounts, tagCounts, total: selectedAccounts.length }
  }, [selectedIds, accounts])

  // Compatibility entry: keep existing call signature
  const getSelectedAccountsGroupStatus = useCallback(() => selectedGroupStatus, [selectedGroupStatus])
  const getSelectedAccountsTagStatus = useCallback(() => selectedTagStatus, [selectedTagStatus])
  
  // Handle grouping operations
  const handleMoveToGroup = (groupId: string | undefined) => {
    if (selectedIds.size === 0) return
    moveAccountsToGroup(Array.from(selectedIds), groupId)
    setShowGroupMenu(false)
  }
  
  // Handle label operations
  const handleAddTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    addTagToAccounts(Array.from(selectedIds), tagId)
  }
  
  const handleRemoveTag = (tagId: string) => {
    if (selectedIds.size === 0) return
    removeTagFromAccounts(Array.from(selectedIds), tagId)
  }
  
  const handleToggleTag = (tagId: string) => {
    const { tagCounts, total } = getSelectedAccountsTagStatus()
    const count = tagCounts.get(tagId) || 0
    
    if (count === total) {
      // All selected accounts have this label, remove it
      handleRemoveTag(tagId)
    } else {
      // Some or no accounts have this label, add
      handleAddTag(tagId)
    }
  }

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const stats = getStats()
  const filteredCount = getFilteredAccounts().length
  const selectedCount = selectedIds.size

  // Group Tab count (all / Not grouped / each group)
  const tabCounts = useMemo(() => {
    const all = accounts.size
    let ungrouped = 0
    const byGroup = new Map<string, number>()
    for (const acc of accounts.values()) {
      if (!acc.groupId) {
        ungrouped++
      } else {
        byGroup.set(acc.groupId, (byGroup.get(acc.groupId) || 0) + 1)
      }
    }
    return { all, ungrouped, byGroup }
  }, [accounts])

  // User grouping by order Ascending order
  const sortedGroups = useMemo(
    () => Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [groups]
  )

  // Currently active Tab display information (for button text + color dots)
  const activeTabInfo = useMemo(() => {
    if (activeGroupTab === 'all') {
      return {
        label: isEn ? 'All' : 'all',
        color: undefined as string | undefined,
        icon: <Users className="h-4 w-4 mr-1.5" />,
        count: tabCounts.all
      }
    }
    if (activeGroupTab === 'ungrouped') {
      return {
        label: isEn ? 'Ungrouped' : 'Not grouped',
        color: undefined as string | undefined,
        icon: <Inbox className="h-4 w-4 mr-1.5" />,
        count: tabCounts.ungrouped
      }
    }
    const g = groups.get(activeGroupTab)
    if (g) {
      return {
        label: g.name,
        color: g.color ? toRgba(g.color) : undefined,
        icon: <FolderPlus className="h-4 w-4 mr-1.5" />,
        count: tabCounts.byGroup.get(g.id) || 0
      }
    }
    // reveal all the details:activeGroupTab is invalid groupId(The group was deleted) → Go back to all
    return {
      label: isEn ? 'All' : 'all',
      color: undefined as string | undefined,
      icon: <Users className="h-4 w-4 mr-1.5" />,
      count: tabCounts.all
    }
  }, [activeGroupTab, groups, tabCounts, isEn])

  const handleSearch = (value: string): void => {
    setFilter({ ...filter, search: value || undefined })
  }

  const handleBatchRefresh = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsRefreshing(true)
    await batchRefreshTokens(Array.from(selectedIds))
    setIsRefreshing(false)
  }

  const handleBatchCheck = async (): Promise<void> => {
    if (selectedCount === 0) return
    setIsChecking(true)
    await batchCheckStatus(Array.from(selectedIds))
    setIsChecking(false)
  }

  // Jump to one-click diagnostic page"Account activity test", do a batch activity test on the currently selected account (the selected status is saved in store, still after page jump)
  const handleBatchLiveness = (): void => {
    if (selectedCount === 0) return
    window.dispatchEvent(new CustomEvent('navigate-page', { detail: 'diagnose' }))
  }

  const handleBatchDelete = (): void => {
    if (selectedCount === 0) return
    if (confirm(isEn ? `Delete ${selectedCount} selected accounts?` : `Are you sure you want to delete the selected ${selectedCount} An account?`)) {
      removeAccounts(Array.from(selectedIds))
    }
  }

  const handleToggleSelectAll = (): void => {
    if (selectedCount === filteredCount && filteredCount > 0) {
      deselectAll()
    } else {
      selectAll()
    }
  }

  return (
    <div className="space-y-3">
      {/* Search and main operations */}
      <div className="flex items-center gap-3">
        {/* search box */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={isEn ? 'Search accounts...' : 'Search account...'}
            className="w-full pl-9 pr-4 py-2 text-sm rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-md border border-[var(--glass-border)] focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/30 transition-all"
            value={filter.search ?? ''}
            onChange={(e) => handleSearch(e.target.value)}
          />
        </div>

        {/* Main operation buttons - Align right */}
        <div className="flex items-center gap-2 ml-auto">
          {/* View switching (card / list) */}
          <div className="flex items-center rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bg-subtle)] backdrop-blur-md overflow-hidden">
            <button
              type="button"
              onClick={() => onViewModeChange('grid')}
              title={isEn ? 'Grid view' : 'card view'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('list')}
              title={isEn ? 'List view' : 'list view'}
              className={`flex items-center justify-center h-8 w-8 transition-colors ${
                viewMode === 'list'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              <ListIcon className="h-4 w-4" />
            </button>
          </div>
          <Button onClick={onAddAccount}>
            <Plus className="h-4 w-4 mr-1" />
            {isEn ? 'Add' : 'Add account'}
          </Button>
          <Button variant="outline" onClick={onImport}>
            <Upload className="h-4 w-4 mr-1" />
            {isEn ? 'Import' : 'import'}
          </Button>
          <Button variant="outline" onClick={onExport}>
            <Download className="h-4 w-4 mr-1" />
            {isEn ? 'Export' : 'Export'}
          </Button>
        </div>
      </div>

      {/* Statistics and selection operations */}
      <div className="flex items-center justify-between">
        {/* Left: Statistics */}
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">
            {isEn ? '' : 'common '}<span className="font-medium text-foreground">{stats.total}</span> {isEn ? 'accounts' : 'accounts'}
            {filteredCount !== stats.total && (
              <span>{isEn ? ', ' : ', filtered '}<span className="font-medium text-foreground">{filteredCount}</span> {isEn ? 'filtered' : 'indivual'}</span>
            )}
          </span>
          {stats.expiringSoonCount > 0 && (
            <Badge variant="destructive" className="gap-1">
              {stats.expiringSoonCount} {isEn ? 'expiring' : 'is about to expire'}
            </Badge>
          )}
        </div>

        {/* Right: Select Actions and Management - narrow spacing */}
        <div className="flex items-center gap-1">
          {/* Group buttons — Switch view + Batch move + manage triple */}
          <div className="relative" ref={groupMenuRef}>
            <Button
              variant={showGroupMenu ? "default" : "ghost"}
              size="sm"
              onClick={() => {
                setShowGroupMenu(!showGroupMenu)
                setShowTagMenu(false)
              }}
              title={isEn ? 'Switch group view / Manage' : 'Switch group view / manage'}
            >
              {activeTabInfo.color ? (
                <span
                  className="w-2.5 h-2.5 rounded-full mr-1.5 flex-shrink-0"
                  style={{ backgroundColor: activeTabInfo.color }}
                />
              ) : (
                activeTabInfo.icon
              )}
              <span className="truncate max-w-[100px]">{activeTabInfo.label}</span>
              <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-[10px] tabular-nums">
                {activeTabInfo.count}
              </Badge>
              <ChevronDown className="h-3 w-3 ml-1" />
            </Button>

            {showGroupMenu && (() => {
              const { groupCounts: selGroupCounts, selectedAccounts: selAccs } = selectedCount > 0
                ? getSelectedAccountsGroupStatus()
                : { groupCounts: new Map<string | undefined, number>(), selectedAccounts: [] as unknown[] }
              const renderTile = (
                key: string,
                isActive: boolean,
                onSwitch: () => void,
                icon: React.ReactNode,
                label: string,
                count: number,
                accentColor?: string,
                moveAction?: { selCount: number; isAllInGroup: boolean; onMove: () => void }
              ) => (
                <div
                  key={key}
                  className={cn(
                    'group relative rounded-md transition-colors',
                    isActive ? '' : 'hover:bg-muted'
                  )}
                  style={isActive && accentColor ? {
                    backgroundColor: accentColor.replace(/[\d.]+\)$/, '0.12)')
                  } : isActive ? {
                    backgroundColor: 'var(--color-primary)',
                    opacity: 0.92
                  } : undefined}
                >
                  <button
                    className={cn(
                      'w-full flex items-center gap-1.5 px-2 py-1.5 text-sm rounded-md text-left',
                      isActive && !accentColor && 'text-primary-foreground'
                    )}
                    style={isActive && accentColor ? { color: accentColor } : undefined}
                    onClick={onSwitch}
                  >
                    {icon}
                    <span className="truncate flex-1 text-xs font-medium">{label}</span>
                    <span className={cn(
                      'text-[10px] tabular-nums',
                      isActive ? (accentColor ? '' : 'text-primary-foreground/80') : 'text-muted-foreground'
                    )}>
                      {count}
                    </span>
                    {isActive && <Check className="h-3 w-3 ml-0.5" />}
                  </button>
                  {/* End-of-line batch move shortcut button — Shown only when account is selected */}
                  {moveAction && (
                    <button
                      className={cn(
                        'absolute right-1 top-1/2 -translate-y-1/2 h-5 w-5 rounded flex items-center justify-center transition-all',
                        'opacity-0 group-hover:opacity-100',
                        moveAction.isAllInGroup
                          ? 'bg-success/15 text-success'
                          : 'bg-background/80 text-muted-foreground hover:text-primary hover:bg-primary/10 shadow-sm'
                      )}
                      onClick={(e) => { e.stopPropagation(); moveAction.onMove() }}
                      title={moveAction.isAllInGroup
                        ? (isEn ? 'All selected already in this group' : 'All selected accounts are already in this group')
                        : (isEn ? `Move ${moveAction.selCount} selected here` : `Move selected ${moveAction.selCount} account here`)
                      }
                    >
                      {moveAction.isAllInGroup ? <Check className="h-3 w-3" /> : <ArrowRightLeft className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              )

              return (
                <div className="absolute left-0 top-full mt-2 z-50 w-[320px] max-h-[80vh] overflow-y-auto bg-popover border rounded-lg shadow-lg p-2">
                  <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />

                  {/* === Section header: title + Check tip === */}
                  <div className="flex items-center justify-between px-2 py-1 mb-1">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {isEn ? 'Groups' : 'Group'}
                    </span>
                    {selectedCount > 0 && (
                      <span className="flex items-center gap-1 text-[10px] text-primary">
                        <ArrowRightLeft className="h-3 w-3" />
                        {isEn ? `${selectedCount} selected` : `Selected ${selectedCount}`}
                      </span>
                    )}
                  </div>

                  {/* === 2 column grid === */}
                  <div className="grid grid-cols-2 gap-1">
                    {/* all */}
                    {renderTile(
                      'all',
                      activeGroupTab === 'all',
                      () => { setActiveGroupTab('all'); setShowGroupMenu(false) },
                      <Users className="h-3.5 w-3.5 flex-shrink-0" />,
                      isEn ? 'All' : 'all',
                      tabCounts.all
                    )}
                    {/* Not grouped — Can be selected"Remove group" */}
                    {renderTile(
                      'ungrouped',
                      activeGroupTab === 'ungrouped',
                      () => { setActiveGroupTab('ungrouped'); setShowGroupMenu(false) },
                      <Inbox className="h-3.5 w-3.5 flex-shrink-0" />,
                      isEn ? 'Ungrouped' : 'Not grouped',
                      tabCounts.ungrouped,
                      undefined,
                      selectedCount > 0 ? {
                        selCount: selectedCount,
                        isAllInGroup: (selGroupCounts.get(undefined) || 0) === selAccs.length,
                        onMove: () => handleMoveToGroup(undefined)
                      } : undefined
                    )}
                    {/* User grouping */}
                    {sortedGroups.map(group => {
                      const color = group.color ? toRgba(group.color) : undefined
                      const isActive = activeGroupTab === group.id
                      const count = tabCounts.byGroup.get(group.id) || 0
                      const selCountInGroup = selGroupCounts.get(group.id) || 0
                      const isAllInGroup = selCountInGroup === selAccs.length && selAccs.length > 0
                      return renderTile(
                        group.id,
                        isActive,
                        () => { setActiveGroupTab(group.id); setShowGroupMenu(false) },
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: color || 'var(--color-muted-foreground)' }}
                        />,
                        group.name,
                        count,
                        color,
                        selectedCount > 0 ? {
                          selCount: selectedCount,
                          isAllInGroup,
                          onMove: () => handleMoveToGroup(group.id)
                        } : undefined
                      )
                    })}
                  </div>

                  {/* === Management grouping === */}
                  <div className="border-t my-2" />
                  <button
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-primary"
                    onClick={() => { setShowGroupMenu(false); onManageGroups() }}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    <span>{isEn ? 'Manage groups' : 'Management grouping'}</span>
                  </button>

                  {/* === Select the prompt (hover Click the end of line button to move) === */}
                  {selectedCount > 0 && (
                    <div className="text-[10px] text-muted-foreground px-2 pt-1 pb-0.5 italic">
                      {isEn
                        ? 'Tip: hover a tile and click ⇄ to move selected accounts here'
                        : 'Tip: Hover the mouse over the group and click on the right ⇄ Click the button to move selected accounts in batches'}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
          
          {/* Label drop-down menu — Pure icon + tooltip, when selected, the little red dot in the upper right corner prompts that there is an operable drop-down */}
          <div className="relative" ref={tagMenuRef}>
            <Button
              variant={showTagMenu ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8 relative"
              onClick={() => {
                if (selectedCount > 0) {
                  setShowTagMenu(!showTagMenu)
                  setShowGroupMenu(false)
                } else {
                  onManageTags()
                }
              }}
              title={selectedCount > 0
                ? (isEn ? `Set tags for ${selectedCount} selected` : `Batch settings ${selectedCount} Tags for selected accounts`)
                : (isEn ? 'Manage tags' : 'Manage tags')
              }
            >
              <Tag className="h-4 w-4" />
              {selectedCount > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </Button>
            
            {showTagMenu && selectedCount > 0 && (
              <div className="absolute left-0 top-full mt-2 z-50 min-w-[220px] bg-popover border rounded-lg shadow-lg p-2">
                <div className="absolute -top-2 left-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
                  {isEn ? `${selectedCount} selected (multi)` : `Selected ${selectedCount} accounts (multiple choices available)`}
                </div>
                <div className="border-t my-1" />
                
                {/* tag list */}
                <div className="max-h-[300px] overflow-y-auto">
                  {Array.from(tags.values()).map(tag => {
                    const { tagCounts, total } = getSelectedAccountsTagStatus()
                    const count = tagCounts.get(tag.id) || 0
                    const isAll = count === total
                    const isPartial = count > 0 && count < total
                    
                    return (
                      <button
                        key={tag.id}
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-left"
                        onClick={() => handleToggleTag(tag.id)}
                      >
                        <div 
                          className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
                          style={{ 
                            backgroundColor: isAll ? (tag.color || '#888') : 'transparent',
                            borderColor: tag.color || '#888'
                          }}
                        >
                          {isAll && <Check className="h-3 w-3 text-white" />}
                          {isPartial && <Minus className="h-3 w-3" style={{ color: tag.color || '#888' }} />}
                        </div>
                        <span className="truncate flex-1">{tag.name}</span>
                        {isPartial && (
                          <span className="text-xs text-muted-foreground">{count}/{total}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
                
                {tags.size === 0 && (
                  <div className="text-sm text-muted-foreground px-2 py-2 text-center">
                    {isEn ? 'No tags' : 'No tags yet'}
                  </div>
                )}
                
                <div className="border-t my-1" />
                <button
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-muted text-primary"
                  onClick={() => {
                    setShowTagMenu(false)
                    onManageTags()
                  }}
                >
                  <Plus className="h-4 w-4" />
                  <span>{isEn ? 'Manage tags' : 'Manage tags'}</span>
                </button>
              </div>
            )}
          </div>
          {/* Agent binding drop-down (highlighted only when the account is selected, and can be used as an information viewing portal when not selected) */}
          <div className="relative" ref={proxyMenuRef}>
            <Button
              variant={showProxyMenu ? 'default' : 'ghost'}
              size="icon"
              className="h-8 w-8 relative"
              onClick={() => {
                setShowProxyMenu(!showProxyMenu)
                setShowGroupMenu(false)
                setShowTagMenu(false)
              }}
              title={selectedCount > 0
                ? (isEn ? `Bind ${selectedCount} selected accounts to a proxy` : `select ${selectedCount} An account is bound to an agent`)
                : (isEn ? 'View proxy bindings' : 'View account-proxy binding')
              }
            >
              <NetworkIcon className="h-4 w-4" />
              {selectedCount > 0 && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
              )}
            </Button>

            {showProxyMenu && (() => {
              const aliveProxies = Array.from(proxyPool.values()).filter((p) => p.enabled && p.status !== 'dead')
              const { proxyCounts, total } = getSelectedProxyBindingStatus()
              return (
                <div className="absolute right-0 top-full mt-2 z-50 w-[320px] max-h-[80vh] overflow-y-auto bg-popover border rounded-lg shadow-lg p-2">
                  <div className="absolute -top-2 right-4 w-4 h-4 bg-popover border-l border-t rotate-45" />

                  <div className="flex items-center justify-between px-2 py-1 mb-1">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {isEn ? 'Proxy Bindings' : 'proxy binding'}
                    </span>
                    {selectedCount > 0 && (
                      <span className="text-[10px] text-primary">
                        {isEn ? `${selectedCount} selected` : `Selected ${selectedCount}`}
                      </span>
                    )}
                  </div>

                  {selectedCount === 0 ? (
                    <div className="px-2 py-3 text-[11px] text-muted-foreground">
                      {isEn
                        ? 'Select accounts first, then choose a proxy to bind to.'
                        : 'Please select the account first and then click on the agent to be bound.'
                      }
                    </div>
                  ) : (
                    <>
                      {aliveProxies.length === 0 ? (
                        <div className="px-2 py-3 text-[11px] text-amber-600 dark:text-amber-400">
                          {isEn
                            ? 'No alive proxies. Add and validate proxies in "Proxy Pool" first.'
                            : 'No proxy available. please first"proxy pool"Add and verify the agent on the page'
                          }
                        </div>
                      ) : (
                        <div className="max-h-[280px] overflow-y-auto">
                          {aliveProxies.map((p) => {
                            const bindCount = proxyCounts.get(p.id) || 0
                            const isAllBound = bindCount === total
                            return (
                              <button
                                key={p.id}
                                className={cn(
                                  'w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded text-left hover:bg-muted transition-colors',
                                  isAllBound && 'bg-primary/10'
                                )}
                                onClick={() => handleBindToProxy(p.id)}
                              >
                                <Link2Icon className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
                                <div className="flex-1 min-w-0">
                                  <div className="font-mono text-xs truncate" title={p.url}>
                                    {p.host}:{p.port}
                                    {p.label && <span className="text-muted-foreground ml-1.5">({p.label})</span>}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                                    <span>{p.protocol}</span>
                                    {p.status === 'alive' && p.latencyMs !== undefined && (
                                      <span className="text-green-600">{p.latencyMs}ms</span>
                                    )}
                                  </div>
                                </div>
                                {bindCount > 0 && (
                                  <Badge variant="outline" className={cn(
                                    'h-4 text-[9px]',
                                    isAllBound ? 'border-primary text-primary' : ''
                                  )}>
                                    {bindCount}/{total}
                                  </Badge>
                                )}
                                {isAllBound && <Check className="h-3 w-3 text-primary" />}
                              </button>
                            )
                          })}
                        </div>
                      )}

                      <div className="border-t my-1" />
                      <button
                        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded hover:bg-destructive/10 text-destructive"
                        onClick={handleUnbindAllSelected}
                        disabled={proxyCounts.get('none') === total}
                      >
                        <UnlinkIcon className="h-3.5 w-3.5" />
                        <span>{isEn ? `Unbind selected (${selectedCount})` : `Unbind selected (${selectedCount})`}</span>
                      </button>
                    </>
                  )}

                  <div className="border-t my-1" />
                  <div className="text-[10px] text-muted-foreground px-2 py-1 italic">
                    {isEn
                      ? 'Tip: bind N accounts to 1 proxy to reduce risk-control association.'
                      : 'Tip: put N accounts bound to the same agent IP, which can reduce risks associated with risk control'
                    }
                  </div>
                </div>
              )
            })()}
          </div>

          <Button
            variant={privacyMode ? "default" : "ghost"}
            size="icon"
            className="h-8 w-8"
            onClick={() => setPrivacyMode(!privacyMode)}
            title={privacyMode ? (isEn ? 'Disable privacy mode' : 'Turn off privacy mode') : (isEn ? 'Enable privacy mode' : 'Turn on privacy mode')}
          >
            {privacyMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          {/* Filter buttons and bubbles */}
          <div className="relative">
            <Button
              variant={isFilterExpanded ? "default" : "ghost"}
              size="icon"
              className="h-8 w-8"
              onClick={onToggleFilter}
              title={isEn ? 'Toggle advanced filter' : 'Expand/Close advanced filtering'}
            >
              <Filter className="h-4 w-4" />
            </Button>
            {/* filter bubble panel */}
            {isFilterExpanded && (
              <div className="absolute right-0 top-full mt-2 z-50 min-w-[600px] bg-popover border rounded-lg shadow-lg">
                {/* bubble arrow */}
                <div className="absolute -top-2 right-4 w-4 h-4 bg-popover border-l border-t rotate-45" />
                <AccountFilterPanel />
              </div>
            )}
          </div>

          <div className="w-px h-6 bg-border mx-1" />

          {/* Batch operation — Pure icon + tooltip(with selected count)*/}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleBatchCheck}
            disabled={isChecking || selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Check ${selectedCount} accounts info (usage / subscription / banned)` : `Check selected ${selectedCount} Account information: refresh usage, subscription details, ban status`)
              : (isEn ? 'Check accounts info (select first)' : 'Check account information (please select account first)')
            }
          >
            {/* and batchRefresh Distinguish icon:Activity represent"View status/Activity" */}
            {isChecking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-emerald-600 hover:text-emerald-600 hover:bg-emerald-500/10"
            onClick={handleBatchLiveness}
            disabled={selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Liveness test ${selectedCount} accounts via reverse-proxy` : `Go against the selection ${selectedCount} Batch activity test of individual accounts`)
              : (isEn ? 'Liveness test (select first)' : 'Account activity test (please select the account first)')
            }
          >
            <Zap className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleBatchDelete}
            disabled={selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Delete ${selectedCount} selected accounts` : `Delete selected ${selectedCount} accounts`)
              : (isEn ? 'Delete (select first)' : 'Delete the selected account (please select the account first)')
            }
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleBatchRefresh}
            disabled={isRefreshing || selectedCount === 0}
            title={selectedCount > 0
              ? (isEn ? `Refresh ${selectedCount} access tokens` : `Refresh selected ${selectedCount} access token for an account`)
              : (isEn ? 'Refresh Token (select first)' : 'refresh Token(Please select the account first)')
            }
          >
            {/* and batchCheck Distinguish icon:KeyRound represent"refresh token",and AccountCard Single account view consistent */}
            {isRefreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          </Button>

          <div className="w-px h-6 bg-border mx-1" />

          {/* Select all / Deselect all */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleSelectAll}
            title={
              selectedCount === filteredCount && filteredCount > 0
                ? (isEn ? 'Deselect all' : 'Deselect all')
                : (isEn ? 'Select all' : 'Select all')
            }
          >
            {selectedCount === filteredCount && filteredCount > 0 ? (
              <CheckSquare className="h-4 w-4 mr-1" />
            ) : (
              <Square className="h-4 w-4 mr-1" />
            )}
            {selectedCount > 0 ? (isEn ? `${selectedCount} sel` : `Selected ${selectedCount}`) : (isEn ? 'All' : 'Select all')}
          </Button>

          {/* Clear selection (only displayed when multiple selections are made, independent clear entry) */}
          {selectedCount > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={() => deselectAll()}
              title={isEn ? `Clear ${selectedCount} selected` : `Clear ${selectedCount} selected`}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
