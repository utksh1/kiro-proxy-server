import { useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { AccountGroup } from '@/types/account'
import { X, Plus, Edit2, Trash2, Users, Check, FolderOpen } from 'lucide-react'

interface GroupManageDialogProps {
  isOpen: boolean
  onClose: () => void
}

export function GroupManageDialog({ isOpen, onClose }: GroupManageDialogProps): React.ReactNode {
  const { groups, accounts, addGroup, updateGroup, removeGroup, moveAccountsToGroup } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  // Edit status
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editColor, setEditColor] = useState('#3b82f6')

  // New status
  const [isCreating, setIsCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newColor, setNewColor] = useState('#3b82f6')

  // Assign account status
  const [assigningGroupId, setAssigningGroupId] = useState<string | null>(null)

  // Get the number of accounts in the group
  const getGroupAccountCount = (groupId: string): number => {
    return Array.from(accounts.values()).filter(acc => acc.groupId === groupId).length
  }

  // Get the number of ungrouped accounts
  const getUngroupedCount = (): number => {
    return Array.from(accounts.values()).filter(acc => !acc.groupId).length
  }

  // Create group
  const handleCreate = () => {
    if (!newName.trim()) return
    addGroup({
      name: newName.trim(),
      description: newDescription.trim() || undefined,
      color: newColor
    })
    setNewName('')
    setNewDescription('')
    setNewColor('#3b82f6')
    setIsCreating(false)
  }

  // Start editing
  const handleStartEdit = (group: AccountGroup) => {
    setEditingId(group.id)
    setEditName(group.name)
    setEditDescription(group.description || '')
    setEditColor(group.color || '#3b82f6')
  }

  // Save edits
  const handleSaveEdit = () => {
    if (!editingId || !editName.trim()) return
    updateGroup(editingId, {
      name: editName.trim(),
      description: editDescription.trim() || undefined,
      color: editColor
    })
    setEditingId(null)
  }

  // Delete group
  const handleDelete = (id: string, name: string) => {
    const count = getGroupAccountCount(id)
    const msg = count > 0
      ? `Are you sure you want to delete the group"${name}"?"\nThis group contains ${count} accounts. After deletion, these accounts will become ungrouped.`
      : `Are you sure you want to delete the group"${name}"?"`
    if (confirm(msg)) {
      removeGroup(id)
    }
  }

  // Batch allocate accounts to groups (does not exit allocation mode, allows continuous operations)
  const handleAssignAccounts = (groupId: string | undefined, accountIds: string[]) => {
    moveAccountsToGroup(accountIds, groupId)
  }

  // Get the list of assignable accounts
  const getAssignableAccounts = (groupId: string) => {
    return Array.from(accounts.values()).filter(acc => acc.groupId !== groupId)
  }

  // Get the list of accounts in the group
  const getGroupAccounts = (groupId: string) => {
    return Array.from(accounts.values()).filter(acc => acc.groupId === groupId)
  }

  const groupList = Array.from(groups.values()).sort((a, b) => a.order - b.order)

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <Card className="relative w-full max-w-2xl max-h-[85vh] overflow-hidden z-10 flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between pb-2 shrink-0">
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            {isEn ? 'Group Management' : 'Group management'}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onClose} className="rounded-lg hover:bg-red-500 hover:text-white transition-colors">
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="flex-1 overflow-auto space-y-4">
          {/* Statistics */}
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>{isEn ? `${groupList.length} groups` : `common ${groupList.length} groups`}</span>
            <span>•</span>
            <span>{isEn ? `${getUngroupedCount()} ungrouped` : `${getUngroupedCount()} ungrouped accounts`}</span>
          </div>

          {/* Create new group */}
          {isCreating ? (
            <div className="p-4 border rounded-lg space-y-3 bg-muted/30">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={newColor}
                  onChange={(e) => setNewColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer"
                />
                <input
                  type="text"
                  placeholder={isEn ? 'Group name' : 'Group name'}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="flex-1 px-3 py-2 border rounded-lg text-sm"
                  autoFocus
                />
              </div>
              <input
                type="text"
                placeholder={isEn ? 'Description (optional)' : 'Group description (optional)'}
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full px-3 py-2 border rounded-lg text-sm"
              />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setIsCreating(false)}>
                  {isEn ? 'Cancel' : 'Cancel'}
                </Button>
                <Button size="sm" onClick={handleCreate} disabled={!newName.trim()}>
                  <Check className="h-4 w-4 mr-1" />
                  {isEn ? 'Create' : 'create'}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" className="w-full" onClick={() => setIsCreating(true)}>
              <Plus className="h-4 w-4 mr-2" />
              {isEn ? 'New Group' : 'Create new group'}
            </Button>
          )}

          {/* grouped list */}
          <div className="space-y-2">
            {groupList.map((group) => (
              <div
                key={group.id}
                className="p-3 border rounded-lg hover:bg-muted/30 transition-colors"
              >
                {editingId === group.id ? (
                  // edit mode
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={editColor}
                        onChange={(e) => setEditColor(e.target.value)}
                        className="w-8 h-8 rounded cursor-pointer"
                      />
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="flex-1 px-3 py-1.5 border rounded text-sm"
                        autoFocus
                      />
                    </div>
                    <input
                      type="text"
                      placeholder={isEn ? 'Description' : 'Group description'}
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      className="w-full px-3 py-1.5 border rounded text-sm"
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditingId(null)}>
                        {isEn ? 'Cancel' : 'Cancel'}
                      </Button>
                      <Button size="sm" onClick={handleSaveEdit}>
                        {isEn ? 'Save' : 'save'}
                      </Button>
                    </div>
                  </div>
                ) : assigningGroupId === group.id ? (
                  // Assign account mode
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded"
                        style={{ backgroundColor: group.color || '#3b82f6' }}
                      />
                      <span className="font-medium">{group.name}</span>
                      <span className="text-sm text-muted-foreground">- Select the account to add</span>
                    </div>
                    
                    {/* Accounts in the current group */}
                    {getGroupAccounts(group.id).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{isEn ? 'Accounts in this group:' : 'Accounts in the current group:'}</p>
                        <div className="flex flex-wrap gap-1">
                          {getGroupAccounts(group.id).map(acc => (
                            <span
                              key={acc.id}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary rounded text-xs"
                            >
                              {acc.email}
                              <button
                                onClick={() => handleAssignAccounts(undefined, [acc.id])}
                                className="hover:text-destructive"
                                title={isEn ? 'Remove from group' : 'Move out of group'}
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Accounts that can be added */}
                    {getAssignableAccounts(group.id).length > 0 && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{isEn ? 'Click to add to this group:' : 'Click to add to this group:'}</p>
                        <div className="flex flex-wrap gap-1 max-h-32 overflow-auto">
                          {getAssignableAccounts(group.id).map(acc => (
                            <button
                              key={acc.id}
                              onClick={() => handleAssignAccounts(group.id, [acc.id])}
                              className="px-2 py-0.5 bg-muted hover:bg-primary/20 rounded text-xs transition-colors"
                            >
                              {acc.email}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={() => setAssigningGroupId(null)}>
                        Finish
                      </Button>
                    </div>
                  </div>
                ) : (
                  // display mode
                  <div className="flex items-center gap-3">
                    <div
                      className="w-4 h-4 rounded shrink-0"
                      style={{ backgroundColor: group.color || '#3b82f6' }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">{group.name}</span>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          {getGroupAccountCount(group.id)}
                        </span>
                      </div>
                      {group.description && (
                        <p className="text-xs text-muted-foreground truncate">{group.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setAssigningGroupId(group.id)}
                        title={isEn ? 'Manage accounts' : 'Manage account'}
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => handleStartEdit(group)}
                        title={isEn ? 'Edit' : 'edit'}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(group.id, group.name)}
                        title={isEn ? 'Delete' : 'delete'}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {groupList.length === 0 && !isCreating && (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>{isEn ? 'No groups' : 'No grouping yet'}</p>
                <p className="text-sm">{isEn ? 'Click the button above to create your first group' : 'Click the button above to create your first group'}</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
