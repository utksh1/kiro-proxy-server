// TLS Client process level shared pool
//
// background:tlsclientwrapper of ModuleClient inside is piscina worker pool + load DLL，
// New each time + open() Approximately 1-3 seconds, and the total can reach tens of seconds during batch registration.
// because DLL path / customLibraryPath Is stable throughout the application life cycle, all Registrar It's entirely possible to share the same ModuleClient
// （SessionClient is the real"Press Register"independent TLS session/fingerprint layer).
//
// design:
//   - first acquireModuleClient() hour open, all subsequent calls directly take the same instance
//   - use openPromise Prevent concurrent initialization from causing duplication open
//   - Unify before main process exits shutdownTlsClientPool() release worker pool

import { ModuleClient } from 'tlsclientwrapper'

interface AcquireOpts {
  /** existing complete DLL File path (first time open when used) */
  customLibraryPath?: string
  /** No customLibraryPath time, by tlsclientwrapper Automatically download to this directory */
  customLibraryDownloadPath?: string
}

let shared: ModuleClient | null = null
let openPromise: Promise<ModuleClient> | null = null

/**
 * get share ModuleClient. first call open(), all subsequent calls will take the same instance.
 * Note: the incoming opts Valid only the first time; ignored on subsequent calls opts Direct reuse.
 */
export async function acquireModuleClient(opts: AcquireOpts): Promise<ModuleClient> {
  if (shared) return shared
  if (openPromise) return openPromise
  openPromise = (async () => {
    const mc = new ModuleClient(opts)
    await mc.open()
    shared = mc
    openPromise = null
    return mc
  })()
  try {
    return await openPromise
  } catch (err) {
    openPromise = null
    throw err
  }
}

/** Whether the shared pool has been enabled (for diagnostic purposes / log) */
export function isModuleClientReady(): boolean {
  return shared !== null
}

/** For debugging: get piscina Pool Statistics */
export function getModuleClientPoolStats(): unknown {
  return shared ? shared.getPoolStats() : null
}

/**
 * Clean up before exiting the application:terminate shared ModuleClient。
 * With timeout protection (5s),avoid DLL Exit is stuck with remaining requests.
 */
export async function shutdownTlsClientPool(): Promise<void> {
  const mc = shared
  shared = null
  openPromise = null
  if (!mc) return
  try {
    await Promise.race([
      mc.terminate(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('terminate timeout')), 5000))
    ])
  } catch { /* time out / piscina Termination errors are ignored */ }
}
