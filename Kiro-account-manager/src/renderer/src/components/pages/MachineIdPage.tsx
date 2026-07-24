import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { 
  Fingerprint, 
  RefreshCw, 
  RotateCcw, 
  Copy, 
  Download, 
  Upload, 
  Shield, 
  Link2, 
  Shuffle,
  History,
  Trash2,
  AlertTriangle,
  CheckCircle,
  Monitor,
  Edit3,
  Check,
  X,
  Users,
  Search
} from 'lucide-react'
import { cn } from '@/lib/utils'

export function MachineIdPage() {
  const {
    machineIdConfig,
    currentMachineId,
    originalMachineId,
    originalBackupTime,
    accountMachineIds,
    machineIdHistory,
    accounts,
    setMachineIdConfig,
    refreshCurrentMachineId,
    changeMachineId,
    restoreOriginalMachineId,
    clearMachineIdHistory,
    bindMachineIdToAccount
  } = useAccountsStore()

  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [isLoading, setIsLoading] = useState(false)
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null)
  const [osType, setOsType] = useState<string>('unknown')
  const [customMachineId, setCustomMachineId] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showAccountBindings, setShowAccountBindings] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const [editingMachineId, setEditingMachineId] = useState('')
  const [accountSearchQuery, setAccountSearchQuery] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // initialization
  useEffect(() => {
    const init = async () => {
      setIsLoading(true)
      try {
        // Get operating system type
        const os = await window.api.machineIdGetOSType()
        setOsType(os)
        
        // Check admin rights
        const admin = await window.api.machineIdCheckAdmin()
        setHasAdmin(admin)
        
        // Refresh current machine code
        await refreshCurrentMachineId()
      } catch (error) {
        console.error('Initialization failed:', error)
      } finally {
        setIsLoading(false)
      }
    }
    init()
  }, [refreshCurrentMachineId])

  // Copy machine code to clipboard
  const copyToClipboard = (text: string, id: string = 'default') => {
    navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  // Randomly generate and apply new machine code
  const handleRandomChange = async () => {
    setIsLoading(true)
    try {
      await changeMachineId()
      await refreshCurrentMachineId()
    } finally {
      setIsLoading(false)
    }
  }

  // Apply custom machine code
  const handleCustomChange = async () => {
    if (!customMachineId.trim()) return
    setIsLoading(true)
    try {
      await changeMachineId(customMachineId.trim())
      await refreshCurrentMachineId()
      setCustomMachineId('')
    } finally {
      setIsLoading(false)
    }
  }

  // Restore original machine code
  const handleRestore = async () => {
    setIsLoading(true)
    try {
      await restoreOriginalMachineId()
      await refreshCurrentMachineId()
    } finally {
      setIsLoading(false)
    }
  }

  // Backup machine code to file
  const handleBackupToFile = async () => {
    if (!currentMachineId) return
    await window.api.machineIdBackupToFile(currentMachineId)
  }

  // Recover machine code from file
  const handleRestoreFromFile = async () => {
    setIsLoading(true)
    try {
      const result = await window.api.machineIdRestoreFromFile()
      if (result.success && result.machineId) {
        await changeMachineId(result.machineId)
        await refreshCurrentMachineId()
      }
    } finally {
      setIsLoading(false)
    }
  }

  // Request administrator permissions
  const handleRequestAdmin = async () => {
    await window.api.machineIdRequestAdminRestart()
  }

  // Generate random UUID
  const generateRandomUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0
      const v = c === 'x' ? r : (r & 0x3 | 0x8)
      return v.toString(16)
    })
  }

  // Start editing account machine code
  const startEditAccountMachineId = (accountId: string) => {
    setEditingAccountId(accountId)
    setEditingMachineId(accountMachineIds[accountId] || '')
  }

  // Save account machine code
  const saveAccountMachineId = (accountId: string) => {
    if (editingMachineId.trim()) {
      bindMachineIdToAccount(accountId, editingMachineId.trim())
    }
    setEditingAccountId(null)
    setEditingMachineId('')
  }

  // Cancel edit
  const cancelEditAccountMachineId = () => {
    setEditingAccountId(null)
    setEditingMachineId('')
  }

  // Generate random machine code for account
  const randomizeAccountMachineId = (accountId: string) => {
    const newMachineId = generateRandomUUID()
    bindMachineIdToAccount(accountId, newMachineId)
    if (editingAccountId === accountId) {
      setEditingMachineId(newMachineId)
    }
  }

  // Delete account machine code binding
  const removeAccountMachineId = (accountId: string) => {
    const { accountMachineIds: currentBindings } = useAccountsStore.getState()
    const newBindings = { ...currentBindings }
    delete newBindings[accountId]
    useAccountsStore.setState({ accountMachineIds: newBindings })
    useAccountsStore.getState().saveToStorage()
  }

  // Format time
  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN')
  }

  // Get operating system display name
  const getOSName = () => {
    switch (osType) {
      case 'windows': return 'Windows'
      case 'macos': return 'macOS'
      case 'linux': return 'Linux'
      default: return isEn ? 'Unknown' : 'unknown'
    }
  }

  // Get the number of account bindings
  const boundAccountCount = Object.keys(accountMachineIds).length

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Hero Header */}
      <div className="page-hero">
        <div className="absolute inset-0 bg-grid-white/5" />
        <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-3xl translate-y-1/2 -translate-x-1/2" />
        
        <div className="relative p-6">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-4">
              <div className="p-4 rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25">
                <Fingerprint className="h-8 w-8 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-primary">
                  {isEn ? 'Machine ID' : 'Machine code management'}
                </h1>
                <p className="text-muted-foreground mt-1">
                  {isEn ? 'Manage device identifier to prevent account bans' : 'Manage device identifiers to prevent account association and bans'}
                </p>
              </div>
            </div>
            <Badge variant="outline" className="bg-background/80 backdrop-blur-sm">
              <Monitor className="h-3 w-3 mr-1" />
              {getOSName()}
            </Badge>
          </div>

          {/* Statistics cards */}
          <div className="grid grid-cols-3 gap-4 mt-6">
            <div className="p-4 rounded-xl bg-background/60 backdrop-blur-sm border border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Fingerprint className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{machineIdHistory.length}</p>
                  <p className="text-xs text-muted-foreground">{isEn ? 'History' : 'Change history'}</p>
                </div>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-background/60 backdrop-blur-sm border border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Link2 className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{boundAccountCount}</p>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Bound Accounts' : 'Account bound'}</p>
                </div>
              </div>
            </div>
            <div className="p-4 rounded-xl bg-background/60 backdrop-blur-sm border border-white/10">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10">
                  <Shield className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{originalMachineId ? (isEn ? 'Backed' : 'Backed up') : (isEn ? 'None' : 'Not backed up')}</p>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Original ID' : 'original machine code'}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* permission warning */}
      {hasAdmin === false && (
        <Card className="border-warning/50 bg-gradient-to-r from-warning/10 to-warning/5 overflow-hidden">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-warning/20">
                  <AlertTriangle className="h-5 w-5 text-warning" />
                </div>
                <div>
                  <p className="font-medium text-warning">{isEn ? 'Admin Required' : 'Requires administrator rights'}</p>
                  <p className="text-sm text-warning/80">{isEn ? 'Run as administrator to modify machine ID' : 'Modifying the machine code requires running the application as an administrator'}</p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleRequestAdmin} className="border-warning/50 hover:bg-warning/10">
                <Shield className="h-4 w-4 mr-1" />
                {isEn ? 'Restart as Admin' : 'Restart as administrator'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Current machine code */}
        <Card className="group relative overflow-hidden hover:shadow-lg transition-all duration-300">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-primary/10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
          <CardHeader className="pb-3 relative z-10">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10">
                <Monitor className="h-4 w-4 text-primary" />
              </div>
              {isEn ? 'Current Machine ID' : 'Current machine code'}
              {currentMachineId && currentMachineId !== originalMachineId && (
                <Badge className="ml-auto bg-primary/10 text-primary border-primary/20">
                  {isEn ? 'Modified' : 'Modified'}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 relative z-10">
            <div className="relative group/code">
              <div className="p-4 bg-muted rounded-xl font-mono text-sm break-all border border-border text-foreground">
                {isLoading ? (
                  <span className="text-muted-foreground flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    {isEn ? 'Loading...' : 'loading...'}
                  </span>
                ) : currentMachineId || (
                  <span className="text-muted-foreground">{isEn ? 'Unable to get' : 'Unable to obtain'}</span>
                )}
              </div>
            </div>
            {machineIdHistory.length > 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <History className="h-3 w-3" />
                {isEn ? 'Last modified:' : 'last modified:'} {formatTime(machineIdHistory[machineIdHistory.length - 1].timestamp)}
              </p>
            )}
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                onClick={() => copyToClipboard(currentMachineId, 'current')}
                disabled={!currentMachineId}
                className="flex-1"
              >
                {copiedId === 'current' ? <Check className="h-4 w-4 mr-1 text-success" /> : <Copy className="h-4 w-4 mr-1" />}
                {copiedId === 'current' ? (isEn ? 'Copied!' : 'Copied') : (isEn ? 'Copy' : 'copy')}
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={async () => {
                  setIsLoading(true)
                  try {
                    await refreshCurrentMachineId()
                  } finally {
                    setIsLoading(false)
                  }
                }}
                disabled={isLoading}
                className="flex-1"
              >
                <RefreshCw className={cn("h-4 w-4 mr-1", isLoading && "animate-spin")} />
                {isEn ? 'Refresh' : 'refresh'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Original machine code backup */}
        <Card className="group relative overflow-hidden hover:shadow-lg transition-all duration-300">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-primary/10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
          <CardHeader className="pb-3 relative z-10">
            <CardTitle className="text-base flex items-center gap-2">
              <div className="p-1.5 rounded-lg bg-primary/10">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              {isEn ? 'Original Machine ID Backup' : 'Original machine code backup'}
              {originalMachineId && (
                <Badge className="ml-auto bg-primary/10 text-primary border-primary/20">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  {isEn ? 'Backed Up' : 'Backed up'}
                </Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 relative z-10">
            {originalMachineId ? (
              <>
                <div className="p-4 bg-gradient-to-br from-primary/5 to-primary/10 rounded-xl font-mono text-sm break-all border border-primary/20">
                  {originalMachineId}
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <CheckCircle className="h-3 w-3 text-primary" />
                  {isEn ? 'Backup time:' : 'Backup time:'} {originalBackupTime ? formatTime(originalBackupTime) : (isEn ? 'Unknown' : 'unknown')}
                </p>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => copyToClipboard(originalMachineId, 'original')}
                    className="flex-1"
                  >
                    {copiedId === 'original' ? <Check className="h-4 w-4 mr-1 text-success" /> : <Copy className="h-4 w-4 mr-1" />}
                    {copiedId === 'original' ? (isEn ? 'Copied!' : 'Copied') : (isEn ? 'Copy' : 'copy')}
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={handleRestore}
                    disabled={isLoading || currentMachineId === originalMachineId}
                    className="flex-1 border-primary/50 hover:bg-primary/10 hover:text-primary"
                  >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    {isEn ? 'Restore' : 'restore original'}
                  </Button>
                </div>
              </>
            ) : (
              <div className="p-6 text-center rounded-xl border-2 border-dashed border-muted">
                <Shield className="h-8 w-8 mx-auto text-muted-foreground/50 mb-2" />
                <p className="text-muted-foreground text-sm">
                  {isEn ? 'Original ID will be backed up on first change' : 'The original value will be automatically backed up when the machine code is modified for the first time.'}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Machine code operations */}
      <Card className="overflow-hidden">
        <CardHeader className="bg-gradient-to-r from-primary/5 to-primary/10 border-b">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Shuffle className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Operations' : 'Machine code operations'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* randomly generated */}
            <div className="group p-5 rounded-xl border-2 border-dashed hover:border-primary/50 hover:bg-primary/5 transition-all space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-br from-primary to-primary/80 text-white">
                  <Shuffle className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="font-semibold">{isEn ? 'Random Generate' : 'randomly generated'}</h4>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Generate UUID format machine ID' : 'One-click generation UUID format machine code'}</p>
                </div>
              </div>
              <Button 
                onClick={handleRandomChange} 
                disabled={isLoading}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground shadow-lg shadow-primary/25"
              >
                <Shuffle className="h-4 w-4 mr-2" />
                {isEn ? 'Generate & Apply' : 'Randomly generate and apply'}
              </Button>
            </div>

            {/* Custom machine code */}
            <div className="group p-5 rounded-xl border-2 border-dashed hover:border-primary/50 hover:bg-primary/5 transition-all space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-gradient-to-br from-primary/80 to-primary text-white">
                  <Edit3 className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="font-semibold">{isEn ? 'Custom Input' : 'custom input'}</h4>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Enter a specific machine ID' : 'Enter the specified machine code'}</p>
                </div>
              </div>
              <input
                type="text"
                placeholder={isEn ? 'Enter UUID format machine ID...' : 'enter UUID format machine code...'}
                value={customMachineId}
                onChange={(e) => setCustomMachineId(e.target.value)}
                className="w-full px-4 py-2.5 text-sm border-2 rounded-xl bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all"
              />
              <Button 
                onClick={handleCustomChange} 
                disabled={isLoading || !customMachineId.trim()}
                variant="outline"
                className="w-full border-2 hover:bg-primary/10 hover:border-primary/50"
              >
                {isEn ? 'Apply Custom ID' : 'Apply custom machine code'}
              </Button>
            </div>
          </div>

          {/* File operations */}
          <div className="flex gap-3 pt-4 border-t">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleBackupToFile} 
              disabled={!currentMachineId}
              className="flex-1 h-10"
            >
              <Download className="h-4 w-4 mr-2" />
              {isEn ? 'Export to File' : 'export to file'}
            </Button>
            <Button 
              variant="outline" 
              size="sm" 
              onClick={handleRestoreFromFile} 
              disabled={isLoading}
              className="flex-1 h-10"
            >
              <Upload className="h-4 w-4 mr-2" />
              {isEn ? 'Import from File' : 'import from file'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Automation settings */}
      <Card className="overflow-hidden">
        <CardHeader className="bg-gradient-to-r from-primary/5 to-primary/10 border-b">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Link2 className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Automation' : 'Automation settings'}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 divide-y">
          {/* Automatically change when switching numbers */}
          <div className="flex items-center justify-between p-5 hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-2.5 rounded-xl transition-colors",
                machineIdConfig.autoSwitchOnAccountChange ? "bg-primary/10" : "bg-muted"
              )}>
                <RefreshCw className={cn(
                  "h-5 w-5 transition-colors",
                  machineIdConfig.autoSwitchOnAccountChange ? "text-primary" : "text-muted-foreground"
                )} />
              </div>
              <div>
                <p className="font-medium">{isEn ? 'Auto Change on Switch' : 'Automatically change the machine code when switching accounts'}</p>
                <p className="text-sm text-muted-foreground">
                  {isEn ? 'Auto generate new ID when switching accounts' : 'Automatically generate and apply new machine code every time you switch accounts'}
                </p>
              </div>
            </div>
            <Button
              variant={machineIdConfig.autoSwitchOnAccountChange ? "default" : "outline"}
              size="sm"
              onClick={() => setMachineIdConfig({ autoSwitchOnAccountChange: !machineIdConfig.autoSwitchOnAccountChange })}
              className={cn(
                "min-w-[80px]",
                machineIdConfig.autoSwitchOnAccountChange && "bg-primary hover:bg-primary/90"
              )}
            >
              {machineIdConfig.autoSwitchOnAccountChange ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>

          {/* Account binding */}
          <div className="flex items-center justify-between p-5 hover:bg-muted/50 transition-colors">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-2.5 rounded-xl transition-colors",
                machineIdConfig.bindMachineIdToAccount ? "bg-primary/10" : "bg-muted"
              )}>
                <Link2 className={cn(
                  "h-5 w-5 transition-colors",
                  machineIdConfig.bindMachineIdToAccount ? "text-primary" : "text-muted-foreground"
                )} />
              </div>
              <div>
                <p className="font-medium flex items-center gap-2">
                  {isEn ? 'Account ID Binding' : 'Account machine code binding'}
                  {boundAccountCount > 0 && (
                    <Badge className="bg-primary/10 text-primary border-primary/20">
                      {isEn ? `${boundAccountCount} accounts` : `${boundAccountCount} accounts`}
                    </Badge>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  {isEn ? 'Assign unique ID per account, auto-apply on switch' : 'Assign a unique machine code to each account and use it automatically when switching'}
                </p>
              </div>
            </div>
            <Button
              variant={machineIdConfig.bindMachineIdToAccount ? "default" : "outline"}
              size="sm"
              onClick={() => setMachineIdConfig({ bindMachineIdToAccount: !machineIdConfig.bindMachineIdToAccount })}
              className={cn(
                "min-w-[80px]",
                machineIdConfig.bindMachineIdToAccount && "bg-primary hover:bg-primary/90"
              )}
            >
              {machineIdConfig.bindMachineIdToAccount ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
            </Button>
          </div>

          {/* Use bound machine code */}
          {machineIdConfig.bindMachineIdToAccount && (
            <div className="flex items-center justify-between p-5 pl-16 bg-muted/30 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-4">
                <div className={cn(
                  "p-2 rounded-lg transition-colors",
                  machineIdConfig.useBindedMachineId ? "bg-primary/10" : "bg-muted"
                )}>
                  <CheckCircle className={cn(
                    "h-4 w-4 transition-colors",
                    machineIdConfig.useBindedMachineId ? "text-primary" : "text-muted-foreground"
                  )} />
                </div>
                <div>
                  <p className="font-medium text-sm">{isEn ? 'Use bound machine ID' : 'Use the unique machine code of the binding'}</p>
                  <p className="text-xs text-muted-foreground">
                    {isEn ? 'When off, generates new ID on each switch' : 'When turned off, new machine code will be randomly generated each time it is switched.'}
                  </p>
                </div>
              </div>
              <Button
                variant={machineIdConfig.useBindedMachineId ? "default" : "outline"}
                size="sm"
                onClick={() => setMachineIdConfig({ useBindedMachineId: !machineIdConfig.useBindedMachineId })}
                className={cn(
                  "min-w-[80px]",
                  machineIdConfig.useBindedMachineId && "bg-primary hover:bg-primary/90"
                )}
              >
                {machineIdConfig.useBindedMachineId ? (isEn ? 'On' : 'Already turned on') : (isEn ? 'Off' : 'Closed')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quick operation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Account machine code management button */}
        <Card className="group cursor-pointer hover:shadow-lg transition-all duration-300 hover:border-primary/50" onClick={() => setShowAccountBindings(true)}>
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 group-hover:from-primary/20 group-hover:to-primary/10 transition-colors">
                <Users className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold group-hover:text-primary transition-colors">{isEn ? 'Account Machine ID' : 'Account machine code management'}</p>
                <p className="text-sm text-muted-foreground">
                  {isEn ? 'View and manage bound machine IDs' : 'View and manage machine codes bound to each account'}
                </p>
              </div>
              <div className="p-2 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors">
                <Edit3 className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* History button */}
        <Card className="group cursor-pointer hover:shadow-lg transition-all duration-300 hover:border-primary/50" onClick={() => setShowHistory(true)}>
          <CardContent className="p-5">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 group-hover:from-primary/20 group-hover:to-primary/10 transition-colors">
                <History className="h-6 w-6 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-semibold group-hover:text-primary transition-colors">{isEn ? 'Change History' : 'Change history'}</p>
                <p className="text-sm text-muted-foreground">
                  {isEn ? `${machineIdHistory.length} records` : `common ${machineIdHistory.length} history records`}
                </p>
              </div>
              <div className="p-2 rounded-lg bg-muted group-hover:bg-primary/10 transition-colors">
                <History className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Account machine code management dialog box */}
      {showAccountBindings && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* background mask */}
          <div 
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowAccountBindings(false)}
          />
          
          {/* Dialog content */}
          <div className="relative bg-background rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* title bar */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                <h2 className="text-lg font-semibold">{isEn ? 'Account Machine ID' : 'Account machine code management'}</h2>
                <Badge variant="secondary">{accounts.size} {isEn ? 'accounts' : 'accounts'}</Badge>
              </div>
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
                onClick={() => setShowAccountBindings(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            
            {/* search box */}
            <div className="px-4 pt-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={accountSearchQuery}
                  onChange={(e) => setAccountSearchQuery(e.target.value)}
                  placeholder={isEn ? 'Search accounts...' : 'Search account...'}
                  className="w-full pl-9 pr-3 py-2 text-sm bg-muted border-0 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {accountSearchQuery && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                    onClick={() => setAccountSearchQuery('')}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
            
            {/* Account list */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {Array.from(accounts.values())
                .filter((account) => {
                  if (!accountSearchQuery.trim()) return true
                  const query = accountSearchQuery.toLowerCase()
                  return (
                    account.email?.toLowerCase().includes(query) ||
                    account.nickname?.toLowerCase().includes(query) ||
                    accountMachineIds[account.id]?.toLowerCase().includes(query)
                  )
                })
                .map((account) => {
                const boundMachineId = accountMachineIds[account.id]
                const isEditing = editingAccountId === account.id
                
                return (
                  <div key={account.id} className="p-3 bg-muted rounded-lg">
                    {/* Account Information Line */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-medium">
                          {(account.nickname || account.email || '?')[0].toUpperCase()}
                        </div>
                        <div className="flex flex-col">
                          <span className="font-medium text-sm truncate max-w-[200px]">
                            {account.nickname || account.email}
                          </span>
                          {account.nickname && account.email && (
                            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                              {account.email}
                            </span>
                          )}
                        </div>
                        {boundMachineId && (
                          <Badge variant="secondary" className="text-xs bg-success/10 text-success">
                            {isEn ? 'Bound' : 'Bound'}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        {!isEditing ? (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => startEditAccountMachineId(account.id)}
                              title={isEn ? 'Edit' : 'edit'}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => randomizeAccountMachineId(account.id)}
                              title={isEn ? 'Random' : 'random'}
                            >
                              <Shuffle className="h-3.5 w-3.5" />
                            </Button>
                            {boundMachineId && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => copyToClipboard(boundMachineId)}
                                  title={isEn ? 'Copy' : 'copy'}
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                  onClick={() => removeAccountMachineId(account.id)}
                                  title={isEn ? 'Delete' : 'delete'}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </>
                            )}
                          </>
                        ) : (
                          <>
                            <Button
                              variant="default"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => saveAccountMachineId(account.id)}
                            >
                              <Check className="h-3.5 w-3.5 mr-1" />
                              {isEn ? 'Save' : 'save'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={cancelEditAccountMachineId}
                            >
                              {isEn ? 'Cancel' : 'Cancel'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={() => randomizeAccountMachineId(account.id)}
                              title={isEn ? 'Random' : 'random'}
                            >
                              <Shuffle className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                    
                    {/* Machine code display/edit */}
                    {isEditing ? (
                      <input
                        type="text"
                        value={editingMachineId}
                        onChange={(e) => setEditingMachineId(e.target.value)}
                        placeholder={isEn ? 'Enter UUID format machine ID' : 'enter UUID format machine code'}
                        className="w-full px-2 py-1.5 text-xs font-mono bg-background border rounded focus:outline-none focus:ring-2 focus:ring-primary"
                        autoFocus
                      />
                    ) : boundMachineId ? (
                      <div className="flex items-center gap-2 px-2 py-1.5 bg-background rounded border">
                        <code className="text-xs font-mono flex-1">{boundMachineId}</code>
                      </div>
                    ) : (
                      <div className="px-2 py-1.5 bg-background/50 rounded border border-dashed text-center">
                        <span className="text-xs text-muted-foreground">{isEn ? 'Not bound' : 'Not bound'}</span>
                      </div>
                    )}
                  </div>
                )
              })}
              
              {accounts.size === 0 && (
                <div className="text-center py-12">
                  <Users className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                  <p className="text-muted-foreground">{isEn ? 'No accounts' : 'No account yet'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Please add accounts first' : 'Please add account first'}</p>
                </div>
              )}
              
              {accounts.size > 0 && accountSearchQuery && 
                Array.from(accounts.values()).filter((account) => {
                  const query = accountSearchQuery.toLowerCase()
                  return (
                    account.email?.toLowerCase().includes(query) ||
                    account.nickname?.toLowerCase().includes(query) ||
                    accountMachineIds[account.id]?.toLowerCase().includes(query)
                  )
                }).length === 0 && (
                <div className="text-center py-8">
                  <Search className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
                  <p className="text-muted-foreground">{isEn ? 'No matches found' : 'No matching account found'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Try other keywords' : 'Try other keywords'}</p>
                </div>
              )}
            </div>
            
            {/* Bottom tip */}
            <div className="px-6 py-3 border-t bg-muted/50 text-xs text-muted-foreground">
              {isEn ? '💡 Tip: After binding, switching to this account will auto-apply the bound machine ID' : '💡 Tip: After binding the machine code, the corresponding machine code will be automatically applied when switching to the account.'}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* History dialog box */}
      {showHistory && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* background mask */}
          <div 
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowHistory(false)}
          />
          
          {/* Dialog content */}
          <div className="relative bg-background rounded-xl shadow-2xl w-[550px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
            {/* title bar */}
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <div className="flex items-center gap-2">
                <History className="h-5 w-5" />
                <h2 className="text-lg font-semibold">{isEn ? 'Change History' : 'Change history'}</h2>
                <Badge variant="secondary">{machineIdHistory.length} {isEn ? 'records' : 'strip'}</Badge>
              </div>
              <div className="flex items-center gap-2">
                {machineIdHistory.length > 0 && (
                  <Button 
                    variant="ghost" 
                    size="sm"
                    onClick={clearMachineIdHistory}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    {isEn ? 'Clear' : 'Clear'}
                  </Button>
                )}
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
                  onClick={() => setShowHistory(false)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            {/* History list */}
            <div className="flex-1 overflow-y-auto p-4">
              {machineIdHistory.length > 0 ? (
                <div className="space-y-2">
                  {[...machineIdHistory].reverse().map((entry, index) => (
                    <div key={entry.id} className="p-3 bg-muted rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">#{machineIdHistory.length - index}</span>
                          <Badge 
                            variant="secondary" 
                            className={cn(
                              "text-xs whitespace-nowrap",
                              entry.action === 'initial' && "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
                              entry.action === 'manual' && "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
                              entry.action === 'auto_switch' && "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
                              entry.action === 'restore' && "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300",
                              entry.action === 'bind' && "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300"
                            )}
                          >
                            {entry.action === 'initial' && (isEn ? 'Init' : 'initial')}
                            {entry.action === 'manual' && (isEn ? 'Manual' : 'Manual')}
                            {entry.action === 'auto_switch' && (isEn ? 'Auto' : 'automatic')}
                            {entry.action === 'restore' && (isEn ? 'Restore' : 'recover')}
                            {entry.action === 'bind' && (isEn ? 'Bind' : 'binding')}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 p-2 bg-background rounded border">
                        <code className="text-sm flex-1 font-mono">{entry.machineId}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 shrink-0"
                          onClick={() => copyToClipboard(entry.machineId)}
                          title={isEn ? 'Copy' : 'copy'}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </div>
                      {entry.accountId && (
                        <p className="text-xs text-muted-foreground mt-2">
                          {isEn ? 'Account: ' : 'Linked accounts: '}{accounts.get(entry.accountId)?.nickname || accounts.get(entry.accountId)?.email || entry.accountId}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <History className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
                  <p className="text-muted-foreground">{isEn ? 'No change records' : 'No change record yet'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Changes will be recorded automatically' : 'Changes to the machine code will be automatically recorded'}</p>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Platform description */}
      <Card className="overflow-hidden bg-gradient-to-br from-muted/50 to-muted/30">
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            <div className="p-2.5 rounded-xl bg-primary/10 shrink-0">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-3">
              <p className="font-semibold">{isEn ? 'Platform Notes' : 'Platform description'}</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Monitor className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">Windows</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Modifies registry MachineGuid, requires admin' : 'Modify registry MachineGuid, requires administrator rights'}</p>
                </div>
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Monitor className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">macOS</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{isEn ? 'App-level override, hardware UUID unchanged' : 'Application layer coverage method, native hardware UUID Cannot modify'}</p>
                </div>
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/10">
                  <div className="flex items-center gap-2 mb-1">
                    <Monitor className="h-4 w-4 text-primary" />
                    <span className="font-medium text-sm">Linux</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{isEn ? 'Modifies /etc/machine-id, requires root' : 'Revise /etc/machine-id,need root Permissions'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                <p className="text-xs text-warning">
                  {isEn ? 'Changing machine ID may affect some software licenses, proceed with caution' : 'Modifying the machine code may affect the authorization of some software, please operate with caution'}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


