import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy as RestoreIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskCenterButton } from './TaskCenter'

/**
 * Cross-platform customization titlebar
 * - macOS: center title + left side traffic lights Reserved (system rendering)
 * - Windows/Linux: Application icons on the left+title + Self-drawn button on the right
 *
 * Drag: whole strip titlebar use -webkit-app-region: drag
 * Button area: use no-drag Make clicks effective
 */
export function TitleBar(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [platform, setPlatform] = useState<NodeJS.Platform>('win32')
  const [isMaximized, setIsMaximized] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let cleanup: (() => void) | undefined

    const init = async () => {
      try {
        const p = await window.api.window.getPlatform()
        setPlatform(p)
        const max = await window.api.window.isMaximized()
        setIsMaximized(max)
      } catch (err) {
        console.warn('[TitleBar] init failed', err)
      }

      // Monitor maximum status changes
      cleanup = window.api.window.onMaximizeChange((m) => setIsMaximized(m))
    }

    init()

    // Get application version number
    window.api.getAppVersion().then(setAppVersion).catch(() => {})

    return () => cleanup?.()
  }, [])

  const isMac = platform === 'darwin'

  return (
    <div
      className={cn(
        'flex items-center h-8 w-full select-none flex-shrink-0',
        'bg-[var(--titlebar-bg)] text-foreground/80',
        'border-b border-foreground/5'
      )}
      style={{
        // whole strip titlebar Draggable
        WebkitAppRegion: 'drag',
        // mac Keep 80px Give traffic lights
        paddingLeft: isMac ? 80 : 12,
        paddingRight: isMac ? 12 : 0
      } as React.CSSProperties}
    >
      {/* application icon + title */}
      <div
        className={cn(
          'flex items-center gap-2 text-xs',
          isMac ? 'flex-1 justify-center' : 'flex-1'
        )}
      >
        {!isMac && (
          <img src="./icon.png" alt="" className="h-4 w-4 opacity-90" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        )}
        <span className="font-medium tracking-wide text-foreground/70">
          Kiro Account manager{appVersion && ` v${appVersion}`}
        </span>
      </div>

      {/* Mission center entrance (only displayed when there are missions) */}
      <div className="flex items-center gap-1 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <TaskCenterButton />
      </div>

      {/* Windows/Linux button group */}
      {!isMac && (
        <div
          className="flex items-stretch h-full"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <TitleBarButton onClick={() => window.api.window.minimize()} title={isEn ? 'Minimize' : 'minimize'}>
            <Minus className="h-3.5 w-3.5" strokeWidth={2} />
          </TitleBarButton>
          <TitleBarButton onClick={() => window.api.window.maximizeToggle()} title={isMaximized ? (isEn ? 'Restore' : 'reduction') : (isEn ? 'Maximize' : 'maximize')}>
            {isMaximized ? (
              <RestoreIcon className="h-3 w-3" strokeWidth={2} />
            ) : (
              <Square className="h-3 w-3" strokeWidth={2} />
            )}
          </TitleBarButton>
          <TitleBarButton onClick={() => window.api.window.close()} title={isEn ? 'Close' : 'closure'} variant="close">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </TitleBarButton>
        </div>
      )}
    </div>
  )
}

interface TitleBarButtonProps {
  onClick: () => void
  title: string
  variant?: 'default' | 'close'
  children: React.ReactNode
}

function TitleBarButton({ onClick, title, variant = 'default', children }: TitleBarButtonProps): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center w-12 h-full text-foreground/70 transition-colors',
        'hover:text-foreground',
        variant === 'close'
          ? 'hover:bg-red-500 hover:text-white'
          : 'hover:bg-foreground/10'
      )}
    >
      {children}
    </button>
  )
}
