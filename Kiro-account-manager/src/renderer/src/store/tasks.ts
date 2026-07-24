import { create } from 'zustand'

/**
 * Global task center
 *
 * Design goal: put the content scattered on each page"Batch tasks"(Register, subscribe,Token Refresh, agent verification...）
 * unified into one store,Depend on TitleBar Shows the total progress, and the sidebar drawer shows details.
 *
 * Any long time-consuming task calling method:
 *   const id = useTaskStore.getState().createTask({...})
 *   useTaskStore.getState().updateTask(id, { progress: 50 })
 *   useTaskStore.getState().completeTask(id, { successCount: 95, failedCount: 5 })
 */

export type TaskKind =
  | 'register-batch'      // Batch registration
  | 'subscription-batch'  // Batch subscription to get link
  | 'overage-batch'       // Turn on excess quota in batches
  | 'proxy-validation'    // Agent pool verification
  | 'token-refresh'       // Token Batch refresh
  | 'account-check'       // Batch check of account status
  | 'other'

export type TaskStatus = 'running' | 'paused' | 'success' | 'failed' | 'cancelled'

export interface TaskEntry {
  id: string
  kind: TaskKind
  /** User-visible task title, e.g. "register 50 accounts" */
  title: string
  /** subtitle, e.g. "MoEmail mode, concurrency 5" */
  subtitle?: string
  status: TaskStatus
  /** 0-100 progress percentage */
  progress: number
  /** Completed */
  done: number
  /** total */
  total: number
  /** Number of successes */
  successCount: number
  /** Number of failures */
  failedCount: number
  /** last log/Status description */
  lastMessage?: string
  /** Error message (on failure) */
  error?: string
  /** Cancel callback: caller registration,UI Can be called by clicking the cancel button */
  onCancel?: () => void
  /** Pause callback (only supported for paused tasks) */
  onPause?: () => void
  /** resume callback */
  onResume?: () => void

  createdAt: number
  updatedAt: number
  finishedAt?: number
}

interface TasksState {
  tasks: Map<string, TaskEntry>
}

interface TasksActions {
  /** Create task and return id;like fixedId If provided, use this id, convenient for the caller to hold the reference */
  createTask: (input: Omit<TaskEntry, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'progress' | 'done' | 'successCount' | 'failedCount'> & {
    fixedId?: string
    status?: TaskStatus
    progress?: number
    done?: number
    successCount?: number
    failedCount?: number
  }) => string
  updateTask: (id: string, updates: Partial<TaskEntry>) => void
  completeTask: (id: string, summary?: { successCount?: number; failedCount?: number; error?: string }) => void
  failTask: (id: string, error: string) => void
  cancelTask: (id: string) => void
  removeTask: (id: string) => void
  clearFinished: () => void
  clearAll: () => void
  /** Returns the current number of tasks in progress (running + paused） */
  getActiveCount: () => number
}

type TasksStore = TasksState & TasksActions

// C7: persistence key
const STORAGE_KEY = 'kiro-task-history'
const MAX_PERSISTED = 200  // most persistent most recent 200 Completed tasks

/** Persistent tasks (only completed tasks, running tasks do not exist) */
function persistTasks(tasks: Map<string, TaskEntry>): void {
  try {
    const finished = Array.from(tasks.values())
      .filter((t) => t.status !== 'running' && t.status !== 'paused')
      .sort((a, b) => (b.updatedAt - a.updatedAt))
      .slice(0, MAX_PERSISTED)
      // Callbacks are not persisted (function cannot be serialized)
      .map(({ onCancel, onPause, onResume, ...rest }) => {
        void onCancel; void onPause; void onResume
        return rest
      })
    localStorage.setItem(STORAGE_KEY, JSON.stringify(finished))
  } catch { /* ignore */ }
}

function loadPersistedTasks(): Map<string, TaskEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const arr = JSON.parse(raw) as TaskEntry[]
    const map = new Map<string, TaskEntry>()
    for (const t of arr) {
      // Forced at startup"Running"marked as"Cancel"(Running tasks will inevitably be interrupted when the application is restarted)
      const status: TaskStatus = (t.status === 'running' || t.status === 'paused') ? 'cancelled' : t.status
      map.set(t.id, { ...t, status })
    }
    return map
  } catch {
    return new Map()
  }
}

export const useTaskStore = create<TasksStore>()((set, get) => ({
  tasks: loadPersistedTasks(),

  createTask: (input) => {
    const id = input.fixedId || crypto.randomUUID()
    const now = Date.now()
    const entry: TaskEntry = {
      id,
      kind: input.kind,
      title: input.title,
      subtitle: input.subtitle,
      status: input.status ?? 'running',
      progress: input.progress ?? 0,
      done: input.done ?? 0,
      total: input.total,
      successCount: input.successCount ?? 0,
      failedCount: input.failedCount ?? 0,
      lastMessage: input.lastMessage,
      error: input.error,
      onCancel: input.onCancel,
      onPause: input.onPause,
      onResume: input.onResume,
      createdAt: now,
      updatedAt: now
    }
    set((state) => {
      const next = new Map(state.tasks)
      next.set(id, entry)
      return { tasks: next }
    })
    return id
  },

  updateTask: (id, updates) => {
    set((state) => {
      const next = new Map(state.tasks)
      const existing = next.get(id)
      if (!existing) return state
      next.set(id, { ...existing, ...updates, updatedAt: Date.now() })
      return { tasks: next }
    })
  },

  completeTask: (id, summary) => {
    set((state) => {
      const next = new Map(state.tasks)
      const existing = next.get(id)
      if (!existing) return state
      const successCount = summary?.successCount ?? existing.successCount
      const failedCount = summary?.failedCount ?? existing.failedCount
      const status: TaskStatus = summary?.error
        ? 'failed'
        : (failedCount > 0 && successCount === 0 ? 'failed' : 'success')
      next.set(id, {
        ...existing,
        status,
        progress: 100,
        successCount,
        failedCount,
        error: summary?.error,
        finishedAt: Date.now(),
        updatedAt: Date.now()
      })
      return { tasks: next }
    })
    persistTasks(get().tasks)
  },

  failTask: (id, error) => {
    set((state) => {
      const next = new Map(state.tasks)
      const existing = next.get(id)
      if (!existing) return state
      next.set(id, {
        ...existing,
        status: 'failed',
        error,
        finishedAt: Date.now(),
        updatedAt: Date.now()
      })
      return { tasks: next }
    })
    persistTasks(get().tasks)
  },

  cancelTask: (id) => {
    const task = get().tasks.get(id)
    try { task?.onCancel?.() } catch { /* ignore */ }
    set((state) => {
      const next = new Map(state.tasks)
      const existing = next.get(id)
      if (!existing) return state
      next.set(id, {
        ...existing,
        status: 'cancelled',
        finishedAt: Date.now(),
        updatedAt: Date.now()
      })
      return { tasks: next }
    })
    persistTasks(get().tasks)
  },

  removeTask: (id) => {
    set((state) => {
      const next = new Map(state.tasks)
      next.delete(id)
      return { tasks: next }
    })
    persistTasks(get().tasks)
  },

  clearFinished: () => {
    set((state) => {
      const next = new Map<string, TaskEntry>()
      for (const [id, t] of state.tasks) {
        if (t.status === 'running' || t.status === 'paused') {
          next.set(id, t)
        }
      }
      return { tasks: next }
    })
    persistTasks(get().tasks)
  },

  clearAll: () => {
    set({ tasks: new Map() })
    persistTasks(get().tasks)
  },

  getActiveCount: () => {
    let count = 0
    for (const t of get().tasks.values()) {
      if (t.status === 'running' || t.status === 'paused') count++
    }
    return count
  }
}))
