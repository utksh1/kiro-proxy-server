import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '../ui'
import { X, FileJson, FileText, Table, Clipboard, Check, Download, Key, Braces } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import type { Account } from '@/types/account'

type ExportFormat = 'json' | 'oidc' | 'txt' | 'csv' | 'kami' | 'clipboard'

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  accounts: Account[]
  selectedCount: number
}

export function ExportDialog({ open, onClose, accounts, selectedCount }: ExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('json')
  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [copied, setCopied] = useState(false)
  const { exportAccounts } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  if (!open) return null

  const formats: { id: ExportFormat; name: string; icon: typeof FileJson; desc: string }[] = [
    { id: 'json', name: 'JSON', icon: FileJson, desc: isEn ? 'Full data, can be imported' : 'Complete data, ready for import' },
    { id: 'oidc', name: 'OIDC JSON', icon: Braces, desc: isEn ? 'Minimal JSON, paste to OIDC batch import' : 'OIDC streamline JSON, can be pasted into batch add' },
    { id: 'kami', name: isEn ? 'Card Key' : 'Cardamom', icon: Key, desc: isEn ? 'email----password----token----id----secret' : 'Card secret format: email----password----Token----ID----Secret' },
    { id: 'txt', name: 'TXT', icon: FileText, desc: isEn ? 'Text format' : (includeCredentials ? 'Importable formats: Email,Token,Nick name,Login method' : 'Plain text format, one account per line') },
    { id: 'csv', name: 'CSV', icon: Table, desc: isEn ? 'Excel compatible' : (includeCredentials ? 'Importable formats,Excel compatible' : 'Excel Compatible formats') },
    { id: 'clipboard', name: isEn ? 'Clipboard' : 'clipboard', icon: Clipboard, desc: isEn ? 'Copy to clipboard' : (includeCredentials ? 'Importable formats: Email,Token' : 'copy to clipboard') },
  ]

  // Generate export content
  const generateContent = (format: ExportFormat): string => {
    switch (format) {
      case 'json':
        // use store of exportAccounts Function exports complete data
        const exportData = exportAccounts(accounts.map(a => a.id))
        // If credentials are not included, remove sensitive information
        if (!includeCredentials) {
          exportData.accounts = exportData.accounts.map(acc => ({
            ...acc,
            credentials: {
              ...acc.credentials,
              accessToken: '',
              refreshToken: '',
              csrfToken: ''
            }
          }))
        }
        return JSON.stringify(exportData, null, 2)

      case 'oidc': {
        // streamline JSON: Contains only key credentials (email address/password/refreshToken/clientId/clientSecret/provider）
        // Field name and OIDC Added in batches JSON Parse alignment, you can copy and paste directly to import
        const minimal = accounts.map(acc => {
          const item: Record<string, string> = {
            email: acc.email,
            refreshToken: acc.credentials?.refreshToken || '',
            provider: acc.idp || 'BuilderId'
          }
          if (acc.password) item.password = acc.password
          if (acc.credentials?.clientId) item.clientId = acc.credentials.clientId
          if (acc.credentials?.clientSecret) item.clientSecret = acc.credentials.clientSecret
          return item
        })
        return JSON.stringify(minimal, null, 2)
      }

      case 'txt':
        if (includeCredentials) {
          // Export importable format when including credentials: Email,RefreshToken,Nick name,Login method
          return accounts.map(acc => 
            [
              acc.email,
              acc.credentials?.refreshToken || '',
              acc.nickname || '',
              acc.idp || 'Google'
            ].join(',')
          ).join('\n')
        }
        // Export summary information when credentials are not included
        return accounts.map(acc => {
          const lines = [
            `Mail: ${acc.email}`,
            acc.nickname ? `Nick name: ${acc.nickname}` : null,
            acc.idp ? `Login method: ${acc.idp}` : null,
            acc.subscription?.title ? `subscription: ${acc.subscription.title}` : null,
            acc.usage ? `Dosage: ${acc.usage.current ?? 0}/${acc.usage.limit ?? 0}` : null,
          ].filter(Boolean)
          return lines.join('\n')
        }).join('\n\n---\n\n')

      case 'csv':
        // CSV Format: Available for import when credentials are included
        const headers = includeCredentials 
          ? ['Mail', 'Nick name', 'Login method', 'RefreshToken', 'ClientId', 'ClientSecret', 'Region']
          : ['Mail', 'Nick name', 'Login method', 'Subscription type', 'Subscribe to titles', 'Amount used', 'total amount']
        const rows = accounts.map(acc => includeCredentials 
          ? [
              acc.email,
              acc.nickname || '',
              acc.idp || '',
              acc.credentials?.refreshToken || '',
              acc.credentials?.clientId || '',
              acc.credentials?.clientSecret || '',
              acc.credentials?.region || 'us-east-1'
            ]
          : [
              acc.email,
              acc.nickname || '',
              acc.idp || '',
              acc.subscription?.type || '',
              acc.subscription?.title || '',
              String(acc.usage?.current ?? ''),
              String(acc.usage?.limit ?? '')
            ]
        )
        // Add to BOM to support Excel Chinese
        return '\ufeff' + [headers, ...rows].map(row => 
          row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n')

      case 'kami':
        // Card secret format: email----password----RefreshToken----ClientId----ClientSecret----Login method
        // No.6Field(Login method/idp)Used to restore the authentication mode when importing:GitHub/Google yes social Login, none ClientId/Secret，
        // Without it, it will be misjudged by the import end as BuilderId(IdC) and verification failed
        return accounts.map(acc => 
          [
            acc.email,
            acc.password || 'no_password',
            acc.credentials?.refreshToken || '',
            acc.credentials?.clientId || '',
            acc.credentials?.clientSecret || '',
            acc.idp || 'BuilderId'
          ].join('----')
        ).join('\n')

      case 'clipboard':
        if (includeCredentials) {
          // Export importable format when including credentials: Email,RefreshToken
          return accounts.map(acc => 
            `${acc.email},${acc.credentials?.refreshToken || ''}`
          ).join('\n')
        }
        // Export summary information when credentials are not included
        return accounts.map(acc => 
          `${acc.email}${acc.nickname ? ` (${acc.nickname})` : ''} - ${acc.subscription?.title || 'Unknown subscription'}`
        ).join('\n')

      default:
        return ''
    }
  }

  // Export processing
  const handleExport = async () => {
    const content = generateContent(selectedFormat)
    const count = accounts.length

    if (selectedFormat === 'clipboard') {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        onClose()
      }, 1500)
      return
    }

    const extensions: Record<string, string> = {
      json: 'json',
      oidc: 'json',
      txt: 'txt',
      csv: 'csv',
      kami: 'txt'
    }
    const filename = `kiro-accounts-${new Date().toISOString().slice(0, 10)}.${extensions[selectedFormat]}`
    
    const success = await window.api.exportToFile(content, filename)
    if (success) {
      alert(isEn ? `Exported ${count} accounts` : `Exported ${count} accounts`)
      onClose()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* background mask */}
      <div 
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      
      {/* dialog box */}
      <div className="relative bg-background rounded-xl shadow-2xl w-[450px] animate-in fade-in zoom-in-95 duration-200">
        {/* title bar */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            <h2 className="text-lg font-semibold">{isEn ? 'Export Accounts' : 'Export account'}</h2>
            <Badge variant="secondary">
              {selectedCount > 0 ? (isEn ? `${selectedCount} selected` : `${selectedCount} selected`) : (isEn ? `All ${accounts.length}` : `all ${accounts.length} indivual`)}
            </Badge>
          </div>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-8 w-8 p-0 rounded-lg hover:bg-red-500 hover:text-white transition-colors"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        {/* Format selection */}
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {formats.map(format => {
              const Icon = format.icon
              const isSelected = selectedFormat === format.id
              return (
                <button
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  className={cn(
                    "p-4 rounded-lg border-2 text-left transition-all",
                    isSelected 
                      ? "border-primary bg-primary/5" 
                      : "border-muted hover:border-muted-foreground/30"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Icon className={cn("h-4 w-4", isSelected && "text-primary")} />
                    <span className={cn("font-medium", isSelected && "text-primary")}>
                      {format.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{format.desc}</p>
                </button>
              )
            })}
          </div>

          {/* Options */}
          {selectedFormat === 'oidc' && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Minimal JSON array (email / password / refreshToken / clientId / clientSecret / provider). Paste directly into the OIDC batch import box.'
                  : 'streamline JSON Array, including Mail / password / RefreshToken / ClientId / ClientSecret / provider, can be pasted directly into "OIDC Batch Add" input box.'}
              </p>
            </div>
          )}
          {selectedFormat === 'kami' && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-xs text-muted-foreground">
                {isEn ? 'Format: email----password----refreshToken----clientId----clientSecret' : 'Format: Email----password----RefreshToken----ClientId----ClientSecret'}
                <br />
                {isEn ? 'One account per line, empty lines are ignored. Supports auto-detection of separators (----, spaces, tabs)' : 'One account per line, blank lines are invalid. Supports automatic identification of delimiters when importing (----, space,Tab）'}
              </p>
            </div>
          )}
          {selectedFormat === 'json' && (
            <label className="flex items-center gap-2 p-3 bg-muted rounded-lg cursor-pointer">
              <input
                type="checkbox"
                checked={includeCredentials}
                onChange={(e) => setIncludeCredentials(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <div>
                <p className="text-sm font-medium">{isEn ? 'Include credentials' : 'Contains credential information'}</p>
                <p className="text-xs text-muted-foreground">{isEn ? 'Include sensitive data for full import' : 'Include Token and other sensitive data, can be used for complete import'}</p>
              </div>
            </label>
          )}
        </div>

        {/* bottom button */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t bg-muted/30">
          <Button variant="outline" onClick={onClose}>
            {isEn ? 'Cancel' : 'Cancel'}
          </Button>
          {(selectedFormat === 'kami' || selectedFormat === 'oidc') && (
            <Button variant="outline" disabled={copied} onClick={async () => {
              const content = generateContent(selectedFormat)
              await navigator.clipboard.writeText(content)
              setCopied(true)
              setTimeout(() => {
                setCopied(false)
                onClose()
              }, 1500)
            }}>
              {copied ? (
                <>
                  <Check className="h-4 w-4 mr-2" />
                  {isEn ? 'Copied' : 'Copied'}
                </>
              ) : (
                <>
                  <Clipboard className="h-4 w-4 mr-2" />
                  {isEn ? 'Copy' : 'copy to clipboard'}
                </>
              )}
            </Button>
          )}
          <Button onClick={handleExport} disabled={copied}>
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-2" />
                {isEn ? 'Copied' : 'Copied'}
              </>
            ) : selectedFormat === 'clipboard' ? (
              <>
                <Clipboard className="h-4 w-4 mr-2" />
                {isEn ? 'Copy' : 'copy to clipboard'}
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                {isEn ? 'Export' : 'Export'}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}


