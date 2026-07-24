// system tray module
import { Tray, Menu, nativeImage, app, BrowserWindow, dialog, MenuItemConstructorOptions, NativeImage } from 'electron'
import { join } from 'path'

// Pallet instance
let tray: Tray | null = null

// Menu icon cache
const menuIcons: Map<string, NativeImage> = new Map()

// Get tray icon directory path
function getTrayIconDir(): string {
  // Development environment and production environment paths are different
  if (app.isPackaged) {
    // asarUnpack will resources Unpack to app.asar.unpacked Table of contents
    return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'tray icon')
  }
  return join(__dirname, '../../resources/tray icon')
}

// Icon name to file name mapping
const ICON_FILE_MAP: Record<string, string> = {
  // application icon
  'app': 'icon.png',
  // status icon
  'status-running': 'Running status.png',
  'status-stopped': 'stop state.png',
  // menu icon
  'mail': 'current account.png',
  'refresh': 'refresh.png',
  'switchAccount': 'switch.png',
  'copy': 'copy.png',
  'window': 'pop up.png',
  'logout': 'quit.png',
  'play': 'play.png',
  'stop': 'stop state.png',
  'check': 'checked.png',
  'warning': 'warn.png',
  'usage': 'Dosage.png',
  'requests': 'ask.png'
}

// Load icon from file
function loadIconFromFile(iconKey: string): NativeImage {
  const cached = menuIcons.get(iconKey)
  if (cached) return cached
  
  const fileName = ICON_FILE_MAP[iconKey]
  if (!fileName) {
    console.warn(`[Tray] Unknown icon key: ${iconKey}`)
    return nativeImage.createEmpty()
  }
  
  const iconPath = join(getTrayIconDir(), fileName)
  try {
    const icon = nativeImage.createFromPath(iconPath)
    // Resize to 16x16 to fit the menu
    const resized = icon.resize({ width: 16, height: 16 })
    menuIcons.set(iconKey, resized)
    return resized
  } catch (error) {
    console.error(`[Tray] Failed to load icon: ${iconPath}`, error)
    return nativeImage.createEmpty()
  }
}

// Get status icon
function getStatusIcon(running: boolean): NativeImage {
  return loadIconFromFile(running ? 'status-running' : 'status-stopped')
}

// Get menu icon
function getMenuIcon(name: string): NativeImage {
  return loadIconFromFile(name)
}

// Current account information (for tray menu display)
interface TrayAccountInfo {
  id: string
  email: string
  idp: string
  status: string
  subscription?: string
  usage?: {
    usedCredits: number
    totalCredits: number
    totalRequests: number
    successRequests: number
    failedRequests: number
  }
}

let currentAccount: TrayAccountInfo | null = null
let accountList: TrayAccountInfo[] = []
let currentLanguage: 'en' | 'zh' = 'zh'

// callback function
interface TrayCallbacks {
  onShowWindow: () => void
  onQuit: () => void
  onRefreshAccount: () => Promise<void>
  onSwitchAccount: () => Promise<void>
  onToggleProxy: () => Promise<void>
  getProxyStatus: () => { running: boolean; port: number }
  getCurrentAccount: () => TrayAccountInfo | null
  getAccountList: () => TrayAccountInfo[]
  getProxyStats: () => { totalRequests: number; successRequests: number; failedRequests: number }
  getSessionStats: () => { totalRequests: number; successRequests: number; failedRequests: number; startTime: number }
}

let callbacks: TrayCallbacks | null = null

// Get tray icon path
function getTrayIconPath(): string {
  // Choose the right icon according to the platform
  if (process.platform === 'win32') {
    // Windows use ico document
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.ico')
    }
    return join(__dirname, '../../resources/icon.ico')
  } else if (process.platform === 'darwin') {
    // macOS use Template Icons (automatically adapt to dark colors/light mode)
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
    }
    return join(__dirname, '../../resources/icon.png')
  } else {
    // Linux use png document
    if (app.isPackaged) {
      return join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'icon.png')
    }
    return join(__dirname, '../../resources/icon.png')
  }
}

// Build tray menu
function buildTrayMenu(): Menu {
  const menuTemplate: MenuItemConstructorOptions[] = []

  const isEn = currentLanguage === 'en'
  
  // Application title
  menuTemplate.push({
    label: `Kiro ${isEn ? 'Account Manager' : 'Account manager'} v${app.getVersion()}`,
    icon: getMenuIcon('app'),
    enabled: false
  })
  menuTemplate.push({ type: 'separator' })

  // Agent service status
  if (callbacks) {
    const proxyStatus = callbacks.getProxyStatus()
    menuTemplate.push({
      label: proxyStatus.running 
        ? (isEn ? `Proxy Running (Port ${proxyStatus.port})` : `The proxy service is running (port ${proxyStatus.port})`) 
        : (isEn ? 'Proxy Stopped' : 'Proxy service has stopped'),
      icon: getStatusIcon(proxyStatus.running),
      enabled: false
    })
    menuTemplate.push({
      label: proxyStatus.running ? (isEn ? 'Stop Proxy' : 'Stop proxy service') : (isEn ? 'Start Proxy' : 'Start proxy service'),
      icon: getMenuIcon(proxyStatus.running ? 'stop' : 'play'),
      click: async () => {
        await callbacks?.onToggleProxy()
        updateTrayMenu()
      }
    })
    menuTemplate.push({ type: 'separator' })
  }

  // Current account information
  const account = callbacks?.getCurrentAccount() || currentAccount
  if (account) {
    menuTemplate.push({
      label: isEn ? 'Current Account' : 'current account',
      icon: getMenuIcon('mail'),
      enabled: false
    })
    menuTemplate.push({
      label: `   ${account.email}`,
      enabled: false
    })
    menuTemplate.push({
      label: isEn 
        ? `   Identity: ${account.idp} | ${account.subscription || 'Unknown'} | ${account.status === 'active' ? 'Active' : account.status}`
        : `   identity: ${account.idp} | ${account.subscription || 'unknown'} | ${account.status === 'active' ? 'active' : account.status}`,
      icon: getMenuIcon(account.status === 'active' ? 'check' : 'warning'),
      enabled: false
    })
    
    if (account.usage) {
      menuTemplate.push({
        label: isEn 
          ? `   Usage: ${account.usage.usedCredits} / ${account.usage.totalCredits} Credits`
          : `   Dosage: ${account.usage.usedCredits} / ${account.usage.totalCredits} Credits`,
        icon: getMenuIcon('usage'),
        enabled: false
      })
    }
    // Get real-time statistics (totals and sessions) from the main process
    const proxyStats = callbacks?.getProxyStats() || { totalRequests: 0, successRequests: 0, failedRequests: 0 }
    const sessionStats = callbacks?.getSessionStats() || { totalRequests: 0, successRequests: 0, failedRequests: 0, startTime: 0 }
    menuTemplate.push({
      label: isEn 
        ? `   Total: ${proxyStats.totalRequests} (✓${proxyStats.successRequests} ✗${proxyStats.failedRequests})`
        : `   total: ${proxyStats.totalRequests} (success${proxyStats.successRequests} fail${proxyStats.failedRequests})`,
      icon: getMenuIcon('requests'),
      enabled: false
    })
    menuTemplate.push({
      label: isEn 
        ? `   Session: ${sessionStats.totalRequests} (✓${sessionStats.successRequests} ✗${sessionStats.failedRequests})`
        : `   This time: ${sessionStats.totalRequests} (success${sessionStats.successRequests} fail${sessionStats.failedRequests})`,
      icon: getMenuIcon('requests'),
      enabled: false
    })
    menuTemplate.push({ type: 'separator' })
  } else {
    menuTemplate.push({
      label: isEn ? 'No Active Account' : 'No active account yet',
      icon: getMenuIcon('mail'),
      enabled: false
    })
    menuTemplate.push({ type: 'separator' })
  }

  // Account operations
  menuTemplate.push({
    label: isEn ? 'Refresh Account Info' : 'Refresh account information',
    icon: getMenuIcon('refresh'),
    click: async () => {
      await callbacks?.onRefreshAccount()
      updateTrayMenu()
    }
  })

  const accounts = callbacks?.getAccountList() || accountList
  const activeAccounts = accounts.filter(a => a.status === 'active')
  menuTemplate.push({
    label: isEn ? `Switch to Next Account (${activeAccounts.length} available)` : `Switch to next account (${activeAccounts.length} available)`,
    icon: getMenuIcon('switchAccount'),
    enabled: activeAccounts.length > 1,
    click: async () => {
      await callbacks?.onSwitchAccount()
      updateTrayMenu()
    }
  })

  menuTemplate.push({ type: 'separator' })

  // Quick operation
  menuTemplate.push({
    label: isEn ? 'Copy Proxy Address' : 'Copy proxy address',
    icon: getMenuIcon('copy'),
    click: () => {
      const { clipboard } = require('electron')
      const proxyStatus = callbacks?.getProxyStatus()
      if (proxyStatus?.running) {
        clipboard.writeText(`http://127.0.0.1:${proxyStatus.port}`)
      }
    },
    enabled: callbacks?.getProxyStatus()?.running ?? false
  })

  menuTemplate.push({ type: 'separator' })

  // Show main window
  menuTemplate.push({
    label: isEn ? 'Show Main Window' : 'Show main window',
    icon: getMenuIcon('window'),
    click: () => {
      callbacks?.onShowWindow()
    }
  })

  // Exit application
  menuTemplate.push({
    label: isEn ? 'Exit' : 'Exit program',
    icon: getMenuIcon('logout'),
    click: () => {
      callbacks?.onQuit()
    }
  })

  return Menu.buildFromTemplate(menuTemplate)
}

// Update tray menu
export function updateTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildTrayMenu())
  }
}

// Update current account information
export function updateCurrentAccount(account: TrayAccountInfo | null): void {
  currentAccount = account
  updateTrayMenu()
}

// Update account list
export function updateAccountList(accounts: TrayAccountInfo[]): void {
  accountList = accounts
  updateTrayMenu()
}

// Update language settings
export function updateTrayLanguage(language: 'en' | 'zh'): void {
  currentLanguage = language
  updateTrayMenu()
}

// Set tray tips
export function setTrayTooltip(tooltip: string): void {
  if (tray) {
    tray.setToolTip(tooltip)
  }
}

// Create pallet
export function createTray(cbs: TrayCallbacks): Tray | null {
  if (tray) {
    return tray
  }

  callbacks = cbs

  try {
    const iconPath = getTrayIconPath()
    let icon = nativeImage.createFromPath(iconPath)
    
    // macOS Need to be set to Template icon
    if (process.platform === 'darwin') {
      icon = icon.resize({ width: 16, height: 16 })
      icon.setTemplateImage(true)
    } else if (process.platform === 'win32') {
      // Windows Icon size adjustment
      icon = icon.resize({ width: 16, height: 16 })
    }

    tray = new Tray(icon)
    tray.setToolTip(currentLanguage === 'en' ? 'Kiro Account Manager' : 'Kiro Account manager')
    tray.setContextMenu(buildTrayMenu())

    // Double-click the tray icon to display the main window
    tray.on('double-click', () => {
      callbacks?.onShowWindow()
    })

    // Windows and Linux: Right-click to display the menu, left-click to display the window
    if (process.platform !== 'darwin') {
      tray.on('click', () => {
        callbacks?.onShowWindow()
      })
    }

    console.log('[Tray] System tray created successfully')
    return tray
  } catch (error) {
    console.error('[Tray] Failed to create system tray:', error)
    return null
  }
}

// Destroy pallet
export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
    callbacks = null
    console.log('[Tray] System tray destroyed')
  }
}

// Get tray instance
export function getTray(): Tray | null {
  return tray
}

// Show close confirmation dialog
export async function showCloseConfirmDialog(mainWindow: BrowserWindow): Promise<'minimize' | 'quit' | 'cancel'> {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Minimize to tray', 'Exit program', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'close window',
    message: 'Do you want to minimize to the system tray or exit the program?',
    detail: 'After minimizing to the tray, the program will continue to run in the background and you can reopen the window by clicking on the tray icon.',
    checkboxLabel: 'remember my choice',
    checkboxChecked: false
  })

  const actions: ('minimize' | 'quit' | 'cancel')[] = ['minimize', 'quit', 'cancel']
  return actions[result.response]
}

// Pallet setup type
export interface TraySettings {
  enabled: boolean
  closeAction: 'ask' | 'minimize' | 'quit'
  showNotifications: boolean
  minimizeOnStart: boolean
}

// Default tray settings
export const defaultTraySettings: TraySettings = {
  enabled: true,
  closeAction: 'ask',
  showNotifications: true,
  minimizeOnStart: false
}
