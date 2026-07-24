import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { X, Save, Plus, Trash2 } from 'lucide-react'

interface McpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpServerEditorProps {
  serverName?: string
  server?: McpServer
  onClose: () => void
  onSaved: () => void
}

export function McpServerEditor({ serverName, server, onClose, onSaved }: McpServerEditorProps) {
  const [name, setName] = useState(serverName || '')
  const [command, setCommand] = useState(server?.command || '')
  const [args, setArgs] = useState<string[]>(server?.args || [])
  const [envVars, setEnvVars] = useState<{ key: string; value: string }[]>(
    server?.env ? Object.entries(server.env).map(([key, value]) => ({ key, value })) : []
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newArg, setNewArg] = useState('')

  const isEdit = !!serverName
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const handleSave = async () => {
    if (!name.trim()) {
      setError(isEn ? 'Please enter server name' : 'Please enter server name')
      return
    }
    if (!command.trim()) {
      setError(isEn ? 'Please enter command' : 'Please enter the command')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const serverConfig: McpServer = {
        command: command.trim(),
        args: args.filter(a => a.trim()),
        env: envVars.reduce((acc, { key, value }) => {
          if (key.trim()) {
            acc[key.trim()] = value
          }
          return acc
        }, {} as Record<string, string>)
      }

      // if not args or env, does not contain these fields
      if (serverConfig.args?.length === 0) delete serverConfig.args
      if (Object.keys(serverConfig.env || {}).length === 0) delete serverConfig.env

      const result = await window.api.saveMcpServer(name.trim(), serverConfig, isEdit ? serverName : undefined)
      
      if (result.success) {
        onSaved()
        onClose()
      } else {
        setError(result.error || (isEn ? 'Save failed' : 'Save failed'))
      }
    } catch (err) {
      setError(isEn ? 'Save failed' : 'Save failed')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const addArg = () => {
    if (newArg.trim()) {
      setArgs([...args, newArg.trim()])
      setNewArg('')
    }
  }

  const removeArg = (index: number) => {
    setArgs(args.filter((_, i) => i !== index))
  }

  const addEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }])
  }

  const updateEnvVar = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...envVars]
    updated[index][field] = value
    setEnvVars(updated)
  }

  const removeEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index))
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div 
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      
      <div className="relative bg-background rounded-lg shadow-xl w-[90vw] max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold">{isEdit ? (isEn ? 'Edit MCP Server' : 'edit MCP server') : (isEn ? 'Add MCP Server' : 'Add to MCP server')}</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {error && (
          <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm">
            {error}
          </div>
        )}

        <div className="flex-1 p-4 space-y-4 overflow-auto">
          {/* Server name */}
          <div>
            <label className="block text-sm font-medium mb-1">{isEn ? 'Server Name' : 'Server name'}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isEn ? 'e.g.: fetch, exa, context7' : 'For example: fetch, exa, context7'}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm"
              disabled={isEdit}
            />
          </div>

          {/* Order */}
          <div>
            <label className="block text-sm font-medium mb-1">{isEn ? 'Command' : 'Order'}</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder={isEn ? 'e.g.: uvx, npx, node' : 'For example: uvx, npx, node'}
              className="w-full px-3 py-2 rounded-md border bg-background text-sm"
            />
          </div>

          {/* parameter */}
          <div>
            <label className="block text-sm font-medium mb-1">{isEn ? 'Arguments' : 'parameter'}</label>
            <div className="space-y-2">
              {args.map((arg, index) => (
                <div key={index} className="flex gap-2">
                  <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{arg}</code>
                  <Button variant="ghost" size="sm" onClick={() => removeArg(index)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newArg}
                  onChange={(e) => setNewArg(e.target.value)}
                  placeholder={isEn ? 'Add argument' : 'Add parameters'}
                  className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && addArg()}
                />
                <Button variant="outline" size="sm" onClick={addArg}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>

          {/* environment variables */}
          <div>
            <label className="block text-sm font-medium mb-1">{isEn ? 'Environment Variables' : 'environment variables'}</label>
            <div className="space-y-2">
              {envVars.map((env, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={env.key}
                    onChange={(e) => updateEnvVar(index, 'key', e.target.value)}
                    placeholder={isEn ? 'Key' : 'variable name'}
                    className="w-1/3 px-2 py-1.5 rounded-md border bg-background text-sm"
                  />
                  <input
                    type="text"
                    value={env.value}
                    onChange={(e) => updateEnvVar(index, 'value', e.target.value)}
                    placeholder={isEn ? 'Value' : 'value'}
                    className="flex-1 px-2 py-1.5 rounded-md border bg-background text-sm"
                  />
                  <Button variant="ghost" size="sm" onClick={() => removeEnvVar(index)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addEnvVar}>
                <Plus className="h-4 w-4 mr-1" />
                {isEn ? 'Add Env Var' : 'Add environment variables'}
              </Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t">
          <Button variant="outline" onClick={onClose}>{isEn ? 'Cancel' : 'Cancel'}</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />
            {saving ? (isEn ? 'Saving...' : 'Saving...') : (isEn ? 'Save' : 'save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}


