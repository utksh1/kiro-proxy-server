/**
 * Machine code management module - main process
 * support Windows、macOS、Linux Three major platforms
 */

import { exec, execSync, spawn } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { app, dialog } from 'electron'

const execAsync = promisify(exec)

/**
 * Find available PowerShell Executable path
 * Try multiple paths according to priority, with different compatibility Windows environment
 */
function findPowerShell(): string | null {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    // PowerShell 7+ (pwsh)
    `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    // standard WindowsPowerShell path
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    // SysWOW64 path(32bit process in64bit system)
    `${systemRoot}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`,
    // Directly use the command name (depending on PATH）
    'pwsh.exe',
    'powershell.exe'
  ]

  for (const candidate of candidates) {
    try {
      // Check if file exists with absolute path
      if (path.isAbsolute(candidate)) {
        if (fs.existsSync(candidate)) return candidate
      } else {
        // Try the command name where.exe Find
        const result = execSync(`where.exe ${candidate}`, {
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['pipe', 'pipe', 'ignore']
        })
        const found = result.trim().split('\n')[0]?.trim()
        if (found && fs.existsSync(found)) return found
      }
    } catch {
      continue
    }
  }
  return null
}

export type OSType = 'windows' | 'macos' | 'linux' | 'unknown'

export interface MachineIdResult {
  success: boolean
  machineId?: string
  error?: string
  requiresAdmin?: boolean
}

/**
 * Get operating system type
 */
export function getOSType(): OSType {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

/**
 * Generate random machine code (GUID Format)
 */
export function generateRandomMachineId(): string {
  // Generate a match Windows MachineGuid Formatted UUID
  return crypto.randomUUID().toLowerCase()
}

/**
 * Get the current machine code
 */
export async function getCurrentMachineId(): Promise<MachineIdResult> {
  const osType = getOSType()

  try {
    switch (osType) {
      case 'windows':
        return await getWindowsMachineId()
      case 'macos':
        return await getMacOSMachineId()
      case 'linux':
        return await getLinuxMachineId()
      default:
        return { success: false, error: 'Unsupported operating system' }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to obtain machine code'
    }
  }
}

/**
 * Set new machine code
 */
export async function setMachineId(newMachineId: string): Promise<MachineIdResult> {
  const osType = getOSType()

  // Verify machine code format
  if (!isValidMachineId(newMachineId)) {
    return { success: false, error: 'Invalid machine code format' }
  }

  try {
    switch (osType) {
      case 'windows':
        return await setWindowsMachineId(newMachineId)
      case 'macos':
        return await setMacOSMachineId(newMachineId)
      case 'linux':
        return await setLinuxMachineId(newMachineId)
      default:
        return { success: false, error: 'Unsupported operating system' }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Failed to set machine code'
    // Check if administrator rights are required
    if (
      errorMsg.includes('Access is denied') ||
      errorMsg.includes('permission denied') ||
      errorMsg.includes('Operation not permitted') ||
      errorMsg.includes('EPERM') ||
      errorMsg.includes('EACCES')
    ) {
      return { success: false, error: 'Requires administrator rights', requiresAdmin: true }
    }
    return { success: false, error: errorMsg }
  }
}

/**
 * Check if you have administrator rights
 */
export async function checkAdminPrivilege(): Promise<boolean> {
  const osType = getOSType()

  try {
    switch (osType) {
      case 'windows': {
        // method1: use PowerShell Check (most reliable, multipath detection)
        const psPath = findPowerShell()
        if (psPath) {
          try {
            const psCmd = `"${psPath}" -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"`
            const result = execSync(psCmd, {
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['pipe', 'pipe', 'ignore']
            })
            const isAdmin = result.trim().toLowerCase() === 'true'
            console.log('[MachineId] PowerShell admin check result:', isAdmin, '(path:', psPath, ')')
            return isAdmin
          } catch (error) {
            console.log('[MachineId] PowerShell admin check failed:', error instanceof Error ? error.message : error)
          }
        } else {
          console.log('[MachineId] PowerShell not found, skipping PS admin check')
        }

        // method2: try net session(Backup, not dependent on PowerShell）
        const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
        const netPath = `${systemRoot}\\System32\\net.exe`
        try {
          const netCmd = fs.existsSync(netPath) ? `"${netPath}" session` : 'net session'
          execSync(netCmd, { stdio: 'ignore', timeout: 3000 })
          console.log('[MachineId] net session succeeded, has admin')
          return true
        } catch {
          console.log('[MachineId] net session failed, no admin')
        }

        // method3: Try writing to the system directory to test permissions
        try {
          const testFile = `${systemRoot}\\Temp\\admin_check_${Date.now()}`
          fs.writeFileSync(testFile, '')
          fs.unlinkSync(testFile)
          return false // Temp Ordinary users can also write to the directory. This method only covers the basics.
        } catch {
          // neglect
        }

        return false
      }

      case 'macos':
        // macOS Writing to the user directory does not require administrator privileges
        return true
      case 'linux':
        // Check if it is root
        return process.getuid?.() === 0
      default:
        return false
    }
  } catch {
    return false
  }
}

/**
 * Request to restart app with administrator privileges
 */
export async function requestAdminRestart(): Promise<boolean> {
  const osType = getOSType()
  const appPath = app.getPath('exe')

  console.log('[MachineId] Requesting admin restart, appPath:', appPath)

  try {
    switch (osType) {
      case 'windows': {
        // Windows: multipath detection PowerShell,use Start-Process -Verb RunAs Elevate privileges
        const psPath = findPowerShell()
        if (psPath) {
          // use spawn Array parameter transfer (do not go cmd parsing)+ PowerShell Single quoted package path:
          // old implementation `-Command "... -FilePath \"path\" ..."` The nested double quotes will be
          // PowerShell argv Parsed and swallowed, the installation path contains spaces (C:\Program Files\...)hour
          // The path is separated by spaces, causing the privilege escalation restart to fail silently.
          const psQuotedPath = appPath.replace(/'/g, "''")
          const psCommand = `Start-Process -FilePath '${psQuotedPath}' -Verb RunAs`
          console.log('[MachineId] Running PowerShell:', psCommand)

          const child = spawn(psPath, ['-NoProfile', '-Command', psCommand], {
            windowsHide: true,
            detached: true,
            stdio: 'ignore'
          })
          child.on('error', (error) => {
            console.error('[MachineId] Admin restart via PowerShell failed:', error)
          })
          child.unref()
        } else {
          // PowerShell Fallback to when unavailable ShellExecute runas
          console.log('[MachineId] PowerShell not found, using electron shell openPath with runas')
          const { shell } = await import('electron')
          shell.openExternal(`file:///${appPath}`)
        }

        // Delay exit to ensure command has time to execute
        setTimeout(() => {
          console.log('[MachineId] Quitting app...')
          app.quit()
        }, 1000)
        return true
      }

      case 'macos': {
        // macOS: use osascript Request administrator permissions.
        // spawn Array parameter passing avoids outer layer shell Quotation mark problem; press the path first POSIX shell Rules wrapped in single quotes
        //(internal ' use '\'' escape) and press AppleScript Double quoted string rules escaping \ and "。
        const shellQuotedPath = `'${appPath.replace(/'/g, "'\\''")}'`
        const appleScriptCmd = `open -n ${shellQuotedPath}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
        const script = `do shell script "${appleScriptCmd}" with administrator privileges`
        const child = spawn('osascript', ['-e', script], { stdio: 'ignore' })
        child.on('error', (error) => {
          console.error('[MachineId] Admin restart failed:', error)
        })
        setTimeout(() => app.quit(), 1000)
        return true
      }

      case 'linux': {
        // Linux: Try using pkexec or gksudo
        const sudoCommands = ['pkexec', 'gksudo', 'kdesudo']
        for (const cmd of sudoCommands) {
          try {
            execSync(`which ${cmd}`, { stdio: 'ignore' })
            exec(`${cmd} "${appPath}"`, (error) => {
              if (error) {
                console.error('[MachineId] Admin restart failed:', error)
              }
            })
            setTimeout(() => app.quit(), 1000)
            return true
          } catch {
            continue
          }
        }
        return false
      }

      default:
        return false
    }
  } catch (error) {
    console.error('Request for administrator privileges failed:', error)
    return false
  }
}

/**
 * Verify machine code format
 */
function isValidMachineId(machineId: string): boolean {
  // UUID Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // pure32bit hexadecimal (Linux machine-id Format)
  const hexRegex = /^[0-9a-f]{32}$/i
  return uuidRegex.test(machineId) || hexRegex.test(machineId)
}

// ==================== Windows ====================

async function getWindowsMachineId(): Promise<MachineIdResult> {
  // method1: use reg query Order
  try {
    const { stdout } = await execAsync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { timeout: 5000 }
    )
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i)
    if (match && match[1]) {
      return { success: true, machineId: match[1].toLowerCase() }
    }
  } catch (error) {
    console.log('[MachineId] reg query failed, trying PowerShell:', error instanceof Error ? error.message : error)
  }

  // method2: use PowerShell Reading the registry (some Win11 More reliable in environment, multi-path detection)
  const psPath = findPowerShell()
  if (psPath) {
    try {
      const { stdout } = await execAsync(
        `"${psPath}" -NoProfile -Command "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid"`,
        { timeout: 10000 }
      )
      const machineId = stdout.trim().toLowerCase()
      if (machineId && isValidMachineId(machineId)) {
        return { success: true, machineId }
      }
    } catch (error) {
      console.log('[MachineId] PowerShell failed, trying WMIC:', error instanceof Error ? error.message : error)
    }
  }

  // method3: use WMIC get UUID(Alternative plan)
  try {
    const { stdout } = await execAsync(
      'wmic csproduct get UUID',
      { timeout: 5000 }
    )
    const lines = stdout.split('\n').filter(line => line.trim() && !line.includes('UUID'))
    if (lines.length > 0) {
      const uuid = lines[0].trim().toLowerCase()
      if (uuid && uuid !== 'ffffffff-ffff-ffff-ffff-ffffffffffff') {
        return { success: true, machineId: uuid }
      }
    }
  } catch (error) {
    console.log('[MachineId] WMIC failed:', error instanceof Error ? error.message : error)
  }

  return {
    success: false,
    error: 'Unable to obtain machine code, please try running as administrator or check system permission settings'
  }
}

async function setWindowsMachineId(newMachineId: string): Promise<MachineIdResult> {
  try {
    // Requires administrator rights
    await execAsync(
      `reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /t REG_SZ /d "${newMachineId}" /f`
    )
    return { success: true, machineId: newMachineId }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : ''
    if (errorMsg.includes('Access is denied') || errorMsg.includes('access denied')) {
      return { success: false, error: 'Requires administrator rights', requiresAdmin: true }
    }
    return { success: false, error: errorMsg || 'set upWindowsMachine code failed' }
  }
}

// ==================== macOS ====================

async function getMacOSMachineId(): Promise<MachineIdResult> {
  try {
    // Read first override File (machine code set by this application)
    const overridePath = path.join(app.getPath('userData'), 'machine-id-override')
    if (fs.existsSync(overridePath)) {
      const overrideId = fs.readFileSync(overridePath, 'utf-8').trim()
      if (overrideId && isValidMachineId(overrideId)) {
        return { success: true, machineId: overrideId }
      }
    }
    
    // examine Kiro IDE of machineid document
    const kiroMachineIdPath = path.join(process.env.HOME || '', 'Library/Application Support/Kiro/machineid')
    if (fs.existsSync(kiroMachineIdPath)) {
      const kiroId = fs.readFileSync(kiroMachineIdPath, 'utf-8').trim()
      if (kiroId && isValidMachineId(kiroId)) {
        return { success: true, machineId: kiroId }
      }
    }

    // Fallback to hardware UUID
    const { stdout } = await execAsync(
      "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { print $3 }'"
    )
    const machineId = stdout.trim().replace(/"/g, '').toLowerCase()
    if (machineId && isValidMachineId(machineId)) {
      return { success: true, machineId }
    }

    return { success: false, error: 'Unable to obtainmacOSmachine code' }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'getmacOSMachine code failed'
    }
  }
}

async function setMacOSMachineId(newMachineId: string): Promise<MachineIdResult> {
  // macOS hardware UUID cannot be modified directly
  // What we wrote in this application override files and sync to Kiro IDE of machineid document
  const overridePath = path.join(app.getPath('userData'), 'machine-id-override')
  const kiroMachineIdPath = path.join(process.env.HOME || '', 'Library/Application Support/Kiro/machineid')

  try {
    // written in this application override document
    fs.writeFileSync(overridePath, newMachineId, 'utf-8')
    
    // Sync to Kiro IDE of machineid document
    try {
      const kiroDir = path.dirname(kiroMachineIdPath)
      if (!fs.existsSync(kiroDir)) {
        fs.mkdirSync(kiroDir, { recursive: true })
      }
      fs.writeFileSync(kiroMachineIdPath, newMachineId, 'utf-8')
      console.log('[MachineId] Synced to Kiro IDE machineid:', kiroMachineIdPath)
    } catch (syncError) {
      console.warn('[MachineId] Failed to sync to Kiro IDE:', syncError)
      // Synchronization failure does not affect the main process
    }
    
    return { success: true, machineId: newMachineId }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'set upmacOSMachine code failed'
    }
  }
}

// ==================== Linux ====================

async function getLinuxMachineId(): Promise<MachineIdResult> {
  const paths = ['/etc/machine-id', '/var/lib/dbus/machine-id']

  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim()
        if (content) {
          // Linux machine-id yes32bit hexadecimal, converted toUUIDFormat
          const formattedId = formatAsUUID(content)
          return { success: true, machineId: formattedId }
        }
      }
    } catch {
      continue
    }
  }

  return { success: false, error: 'Unable to obtainLinuxmachine code' }
}

async function setLinuxMachineId(newMachineId: string): Promise<MachineIdResult> {
  // Convert to32digit hexadecimal format (hyphens removed)
  const rawId = newMachineId.replace(/-/g, '').toLowerCase()

  const paths = ['/etc/machine-id', '/var/lib/dbus/machine-id']

  // First try writing directly (if you have permission)
  for (const filePath of paths) {
    try {
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, rawId + '\n', 'utf-8')
        return { success: true, machineId: newMachineId }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : ''
      if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
        // Administrator rights are required, try using pkexec write directly
        const pkexecResult = await setLinuxMachineIdWithPkexec(rawId, filePath)
        if (pkexecResult.success) {
          return { success: true, machineId: newMachineId }
        }
        // if pkexec Failure, continue trying other paths or return an error
        if (pkexecResult.error?.includes('User cancels') || pkexecResult.error?.includes('dismissed')) {
          return { success: false, error: 'User canceled authorization' }
        }
      }
    }
  }

  return { success: false, error: 'set upLinuxMachine code failed' }
}

/**
 * use pkexec by root Permission to write Linux machine code
 * This method does not require restarting the entire application and avoids Wayland Display authorization issues
 */
async function setLinuxMachineIdWithPkexec(rawId: string, filePath: string): Promise<MachineIdResult> {
  const sudoCommands = ['pkexec', 'gksudo', 'kdesudo']
  
  for (const cmd of sudoCommands) {
    try {
      // Check if the command exists
      execSync(`which ${cmd}`, { stdio: 'ignore' })
      
      // use pkexec/gksudo call tee Command to write to file
      // tee The command can be root Permission to write files
      const command = `echo "${rawId}" | ${cmd} tee "${filePath}" > /dev/null`
      console.log(`[MachineId] Running: ${cmd} to write machine-id`)
      
      await execAsync(command)
      
      // if there is still /var/lib/dbus/machine-id, also update it
      if (filePath === '/etc/machine-id') {
        const dbusPath = '/var/lib/dbus/machine-id'
        if (fs.existsSync(dbusPath)) {
          try {
            const dbusCommand = `echo "${rawId}" | ${cmd} tee "${dbusPath}" > /dev/null`
            await execAsync(dbusCommand)
          } catch {
            // neglect dbus machine-id Update failed
          }
        }
      }
      
      return { success: true, machineId: rawId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : ''
      console.log(`[MachineId] ${cmd} failed:`, errorMsg)
      
      // User cancels authorization
      if (errorMsg.includes('dismissed') || errorMsg.includes('Not authorized') || errorMsg.includes('126')) {
        return { success: false, error: 'User canceled authorization' }
      }
      // Continue trying the next command
      continue
    }
  }
  
  return { success: false, error: 'No privilege escalation tools available', requiresAdmin: true }
}

/**
 * Will32bit hexadecimal toUUIDFormat
 */
function formatAsUUID(hex: string): string {
  const clean = hex.replace(/-/g, '').toLowerCase()
  if (clean.length !== 32) return clean
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
}

/**
 * Backup machine code to file
 */
export async function backupMachineIdToFile(
  machineId: string,
  filePath: string
): Promise<boolean> {
  try {
    const backupData = {
      machineId,
      backupTime: Date.now(),
      osType: getOSType(),
      appVersion: app.getVersion()
    }
    fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('Backup machine code failed:', error)
    return false
  }
}

/**
 * Recover machine code from file
 */
export async function restoreMachineIdFromFile(filePath: string): Promise<MachineIdResult> {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'Backup file does not exist' }
    }
    const content = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content)
    if (!data.machineId || !isValidMachineId(data.machineId)) {
      return { success: false, error: 'Backup file format is invalid' }
    }
    return { success: true, machineId: data.machineId }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read backup file'
    }
  }
}

/**
 * Shows a dialog box that requires administrator privileges
 */
export async function showAdminRequiredDialog(): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Requires administrator rights',
    message: 'Modifying machine code requires administrator privileges',
    detail: 'Restart the application with administrator rights?',
    buttons: ['Cancel', 'Restart as administrator'],
    defaultId: 1,
    cancelId: 0
  })
  return result.response === 1
}
