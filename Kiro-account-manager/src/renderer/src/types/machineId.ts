/**
 * Machine code management related type definitions
 */

// Operating system type
export type OSType = 'windows' | 'macos' | 'linux' | 'unknown'

// Machine code configuration
export interface MachineIdConfig {
  // Automatically switch machine codes (automatically change when cutting numbers)
  autoSwitchOnAccountChange: boolean
  // Account machine code binding (each account is associated with a unique machine code)
  bindMachineIdToAccount: boolean
  // Use the binding's unique machine code (otherwise randomly generated)
  useBindedMachineId: boolean
}

// Machine code status
export interface MachineIdState {
  // Current system machine code
  currentMachineId: string
  // Backup original machine code
  originalMachineId: string | null
  // Original machine code backup time
  originalBackupTime: number | null
  // Operating system type
  osType: OSType
  // Do you have administrator rights?
  hasAdminPrivilege: boolean
  // Is it in operation?
  isOperating: boolean
  // Last operation error
  lastError: string | null
  // Configuration
  config: MachineIdConfig
  // Machine code mapping for account binding (accountId -> machineId)
  accountMachineIds: Record<string, string>
  // Machine code history
  history: MachineIdHistoryEntry[]
}

// Machine code history
export interface MachineIdHistoryEntry {
  id: string
  machineId: string
  timestamp: number
  action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
  accountId?: string
  accountEmail?: string
}

// Machine code operation results
export interface MachineIdResult {
  success: boolean
  machineId?: string
  error?: string
  requiresAdmin?: boolean
}

// main process API interface
export interface MachineIdAPI {
  // Get the current machine code
  getCurrentMachineId: () => Promise<MachineIdResult>
  // Set new machine code
  setMachineId: (newMachineId: string) => Promise<MachineIdResult>
  // Generate random machine code
  generateRandomMachineId: () => string
  // Check admin rights
  checkAdminPrivilege: () => Promise<boolean>
  // Request administrator permission to restart
  requestAdminRestart: () => Promise<boolean>
  // Get operating system type
  getOSType: () => OSType
  // Backup machine code to file
  backupMachineIdToFile: (machineId: string, path: string) => Promise<boolean>
  // Recover machine code from file
  restoreMachineIdFromFile: (path: string) => Promise<MachineIdResult>
}
