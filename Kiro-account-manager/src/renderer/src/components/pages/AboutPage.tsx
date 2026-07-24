import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import { Github, Heart, Code, ExternalLink, User, Coffee, MessageCircle, X, RefreshCw, Download, CheckCircle, AlertCircle, Info, Zap } from 'lucide-react'
import kiroLogo from '@/assets/kiro-high-resolution-logo-transparent.png'
import alipayQR from '@/assets/支付宝支付.png'
import wechatQR from '@/assets/微信支付.png'
import groupQR from '@/assets/交流群.png'
import authorAvatar from '@/assets/author-avatar.png'
import { useAccountsStore } from '@/store/accounts'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  releaseNotes?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  assets?: Array<{
    name: string
    downloadUrl: string
    size: number
  }>
  error?: string
}

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const [showGroupQR, setShowGroupQR] = useState(false)
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const { darkMode } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
    // Do not automatically check for updates, avoid GitHub API rate limit
    // Users can manually click"Check for updates"button
  }, [])

  const checkForUpdates = async (showModal = true) => {
    setIsCheckingUpdate(true)
    try {
      const result = await window.api.checkForUpdatesManual()
      setUpdateInfo(result)
      if (showModal || result.hasUpdate) {
        setShowUpdateModal(true)
      }
    } catch (error) {
      console.error('Check update failed:', error)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const openReleasePage = () => {
    if (updateInfo?.releaseUrl) {
      window.api.openExternal(updateInfo.releaseUrl)
    }
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-8">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative text-center space-y-4">
          <img 
            src={kiroLogo} 
            alt="Kiro" 
            className={cn("h-20 w-auto mx-auto transition-all", darkMode && "invert brightness-0")} 
          />
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'Kiro Account Manager' : 'Kiro Account manager'}</h1>
            <p className="text-muted-foreground">{isEn ? `Version ${version}` : `Version ${version}`}</p>
          </div>
        <div className="flex gap-2 justify-center flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => checkForUpdates(true)}
            disabled={isCheckingUpdate}
          >
            <RefreshCw className={cn("h-4 w-4", isCheckingUpdate && "animate-spin")} />
            {isCheckingUpdate ? (isEn ? 'Checking...' : 'Under inspection...') : (isEn ? 'Check Updates' : 'Check for updates')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => setShowGroupQR(true)}
          >
            <MessageCircle className="h-4 w-4" />
            {isEn ? 'Join Group' : 'Join the communication group'}
          </Button>
        </div>
        
        {/* Update tips */}
        {updateInfo?.hasUpdate && !showUpdateModal && (
          <div 
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary/10 text-primary rounded-full text-sm cursor-pointer hover:bg-primary/20"
            onClick={() => setShowUpdateModal(true)}
          >
            <Download className="h-4 w-4" />
            {isEn ? `New version v${updateInfo.latestVersion}` : `new version found v${updateInfo.latestVersion}`}
          </div>
        )}
        </div>
      </div>

      {/* Update pop-up window */}
      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowUpdateModal(false)} />
          <div className="relative bg-card rounded-xl p-6 shadow-xl z-10 max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto">
            <button
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              onClick={() => setShowUpdateModal(false)}
            >
              <X className="h-5 w-5" />
            </button>
            
            <div className="space-y-4">
              {updateInfo.hasUpdate ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-success/10">
                      <Download className="h-6 w-6 text-success" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'New Version Available' : 'new version found'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {updateInfo.currentVersion} → {updateInfo.latestVersion}
                      </p>
                    </div>
                  </div>
                  
                  <div className="bg-muted/50 rounded-lg p-3">
                    <p className="text-sm font-medium mb-2">{updateInfo.releaseName}</p>
                    {updateInfo.publishedAt && (
                      <p className="text-xs text-muted-foreground">
                        {isEn ? `Released: ${new Date(updateInfo.publishedAt).toLocaleDateString('en-US')}` : `Release time: ${new Date(updateInfo.publishedAt).toLocaleDateString('zh-CN')}`}
                      </p>
                    )}
                  </div>
                  
                  {updateInfo.releaseNotes && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{isEn ? 'Release Notes:' : 'Update content:'}</p>
                      <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg p-3 max-h-32 overflow-y-auto whitespace-pre-wrap">
                        {updateInfo.releaseNotes}
                      </div>
                    </div>
                  )}
                  
                  {updateInfo.assets && updateInfo.assets.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-sm font-medium">{isEn ? 'Download Files:' : 'Download file:'}</p>
                      <div className="space-y-1 max-h-32 overflow-y-auto">
                        {updateInfo.assets.slice(0, 6).map((asset, i) => (
                          <div key={i} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2 py-1">
                            <span className="truncate flex-1">{asset.name}</span>
                            <span className="text-muted-foreground ml-2">{formatFileSize(asset.size)}</span>
                          </div>
                        ))}
                        {updateInfo.assets.length > 6 && (
                          <p className="text-xs text-muted-foreground text-center">
                            {isEn ? `${updateInfo.assets.length - 6} more files...` : `besides ${updateInfo.assets.length - 6} files...`}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  
                  <Button className="w-full gap-2" onClick={openReleasePage}>
                    <ExternalLink className="h-4 w-4" />
                    {isEn ? 'Go to Download Page' : 'Go to download page'}
                  </Button>
                </>
              ) : updateInfo.error ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-red-500/10">
                      <AlertCircle className="h-6 w-6 text-red-500" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'Check Failed' : 'Check for updates failed'}</h3>
                      <p className="text-sm text-muted-foreground">{updateInfo.error}</p>
                    </div>
                  </div>
                  <Button variant="outline" className="w-full" onClick={() => checkForUpdates(true)}>
                    {isEn ? 'Retry' : 'Try again'}
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded-full bg-success/10">
                      <CheckCircle className="h-6 w-6 text-success" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-lg">{isEn ? 'Up to Date' : 'Already the latest version'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {isEn ? `Version v${updateInfo.currentVersion} is the latest` : `Current version v${updateInfo.currentVersion} Already the latest`}
                      </p>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Communication group pop-up window */}
      {showGroupQR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowGroupQR(false)} />
          <div className="relative bg-card rounded-xl p-6 shadow-xl z-10">
            <button
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground"
              onClick={() => setShowGroupQR(false)}
            >
              <X className="h-5 w-5" />
            </button>
            <div className="text-center space-y-3">
              <h3 className="font-semibold text-lg">{isEn ? 'Join Group' : 'Scan the QR code to join the communication group'}</h3>
              <div className="bg-[#07C160]/5 rounded-xl p-3 border border-[#07C160]/20">
                <img src={groupQR} alt="Group" className="w-48 h-48 object-contain" />
              </div>
              <p className="text-sm text-muted-foreground">{isEn ? 'Scan with WeChat' : 'QQ Scan the code to join'}</p>
            </div>
          </div>
        </div>
      )}

      {/* Description */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'About' : 'About this app'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>
            {isEn 
              ? 'Kiro Account Manager is a powerful multi-account management tool for Kiro IDE. It supports quick account switching, auto token refresh, group/tag management, and machine ID management.'
              : 'Kiro Account Manager is a powerful Kiro IDE Multi-account management tool. Supports quick switching of multiple accounts, automatic Token Refresh, group tag management, machine code management and other functions help you efficiently manage and use multiple Kiro account.'}
          </p>
          <p>
            {isEn 
              ? 'Built with Electron + React + TypeScript, supporting Windows, macOS and Linux. All data is stored locally to protect your privacy.'
              : 'This application uses Electron + React + TypeScript development, support Windows、macOS and Linux platform. All data is stored locally to protect your privacy.'}
          </p>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Features' : 'Main functions'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Multi-Account' : 'Multiple account management'}</strong>{isEn ? ': Add, edit, delete multiple accounts' : ':Support adding, editing and deleting multiple Kiro account'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'One-Click Switch' : 'One click switch'}</strong>{isEn ? ': Quick account switching' : ': Quickly switch the currently used account'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Refresh' : 'Auto refresh'}</strong>{isEn ? ': Auto refresh tokens before expiry' : '：Token Automatically refresh before expiration and keep logged in status'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Groups & Tags' : 'Grouping and labeling'}</strong>{isEn ? ': Batch set groups/tags' : ':Multi-select accounts to set groups in batches/Tags, supports multiple tags'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Privacy Mode' : 'privacy mode'}</strong>{isEn ? ': Hide sensitive info' : ':Hide sensitive email and account information'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Batch Import' : 'Batch import'}</strong>{isEn ? ': SSO Token & OIDC batch import' : ':support SSO Token and OIDC Voucher batch import'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Machine ID' : 'Machine code management'}</strong>{isEn ? ': Modify device identifier' : ': Modify the device identifier to prevent account association bans'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch ID' : 'Automatically change machine code'}</strong>{isEn ? ': Auto change ID on switch' : ': Automatically change the machine code when switching accounts'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'ID Binding' : 'Account machine code binding'}</strong>{isEn ? ': Unique ID per account' : ': Assign a unique machine code to each account'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Auto Switch' : 'Automatic number change'}</strong>{isEn ? ': Switch when balance low' : ': Automatically switch available accounts when the balance is insufficient'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Proxy Support' : 'Agent support'}</strong>{isEn ? ': HTTP/HTTPS/SOCKS5' : ':support HTTP/HTTPS/SOCKS5 acting'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>{isEn ? 'Themes' : 'Theme customization'}</strong>{isEn ? ': 32 colors, dark/light mode' : '：32 theme color, dark/light mode'}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Code className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Tech Stack' : 'technology stack'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'Zustand', 'Vite'].map((tech) => (
              <span 
                key={tech}
                className="px-2.5 py-1 text-xs bg-muted rounded-full text-muted-foreground"
              >
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Author */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <User className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Author' : 'author'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img 
                src={authorAvatar}
                alt="chaogei666"
                className="w-10 h-10 rounded-full"
              />
              <p className="font-medium">chaogei666</p>
            </div>
            <a 
              href="https://github.com/chaogei/Kiro-account-manager" 
              target="_blank" 
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-lg hover:bg-muted"
            >
              <Github className="h-4 w-4" />
              GitHub
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardContent>
      </Card>

      {/* Sponsor */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Coffee className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Sponsor' : 'Sponsorship support'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {isEn ? 'If this project helps you, buy me a coffee ☕' : 'If this project is helpful to you, you can buy the author a cup of coffee ☕'}
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="text-center space-y-2">
              <div className="bg-[#1677FF]/5 rounded-xl p-3 border border-[#1677FF]/20">
                <img src={alipayQR} alt="Alipay" className="w-full aspect-square object-contain rounded-lg" />
              </div>
              <p className="text-sm font-medium text-[#1677FF]">{isEn ? 'Alipay' : 'Alipay'}</p>
            </div>
            <div className="text-center space-y-2">
              <div className="bg-[#07C160]/5 rounded-xl p-3 border border-[#07C160]/20">
                <img src={wechatQR} alt="WeChat Pay" className="w-full aspect-square object-contain rounded-lg" />
              </div>
              <p className="text-sm font-medium text-[#07C160]">{isEn ? 'WeChat Pay' : 'WeChat Pay'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground py-4">
        <p className="flex items-center justify-center gap-1">
          Made with <Heart className="h-3 w-3 text-primary" /> for Kiro users
        </p>
      </div>
    </div>
  )
}
