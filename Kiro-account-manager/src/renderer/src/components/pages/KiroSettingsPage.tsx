import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, Toggle, Select } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import { SteeringEditor, McpServerEditor } from '../kiro'
import { 
  FileText, 
  ChevronDown, 
  ChevronUp, 
  Plus, 
  Trash2, 
  RefreshCw,
  ExternalLink,
  FolderOpen,
  Save,
  AlertCircle,
  Edit,
  Sparkles,
  Shield,
  Zap,
  Settings2,
  Terminal
} from 'lucide-react'

interface KiroSettings {
  agentAutonomy: string
  modelSelection: string
  enableDebugLogs: boolean
  enableTabAutocomplete: boolean
  enableCodebaseIndexing: boolean
  usageSummary: boolean
  codeReferences: boolean
  configureMCP: string
  trustedCommands: string[]
  trustedTools: Record<string, boolean>
  commandDenylist: string[]
  ignoreFiles: string[]
  mcpApprovedEnvVars: string[]
  // Notification settings
  notificationsActionRequired: boolean
  notificationsFailure: boolean
  notificationsSuccess: boolean
  notificationsBilling: boolean
}

interface McpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers: Record<string, McpServer>
}

// Dangerous commands banned by default
const defaultDenyCommands = [
  'rm -rf *',
  'rm -rf /',
  'rm -rf ~',
  'del /f /s /q *',
  'format',
  'mkfs',
  'dd if=',
  ':(){:|:&};:',
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'wget * | sh',
  'curl * | sh',
  'shutdown',
  'reboot',
  'init 0',
  'init 6'
]

// Kiro Default settings (with Kiro IDE The built-in default values ​​are consistent)
const defaultSettings: KiroSettings = {
  agentAutonomy: 'Autopilot',
  modelSelection: 'auto',
  enableDebugLogs: false,
  enableTabAutocomplete: false,
  enableCodebaseIndexing: false,
  usageSummary: true,
  codeReferences: false,
  configureMCP: 'Enabled',
  trustedCommands: [],
  trustedTools: {},
  commandDenylist: [],
  ignoreFiles: [],
  mcpApprovedEnvVars: [],
  notificationsActionRequired: true,
  notificationsFailure: false,
  notificationsSuccess: false,
  notificationsBilling: true
}

const autonomyOptionsZh = [
  { value: 'Autopilot', label: 'Autopilot (Automatic execution)', description: 'Agent Automate tasks' },
  { value: 'Supervised', label: 'Supervised (Need to confirm)', description: 'Each step requires manual confirmation' }
]

const autonomyOptionsEn = [
  { value: 'Autopilot', label: 'Autopilot (Auto)', description: 'Agent executes tasks automatically' },
  { value: 'Supervised', label: 'Supervised (Confirm)', description: 'Manual confirmation for each step' }
]

const mcpOptionsZh = [
  { value: 'Enabled', label: 'enable', description: 'allow MCP Server connection' },
  { value: 'Disabled', label: 'Disable', description: 'Disable all MCP Function' }
]

const mcpOptionsEn = [
  { value: 'Enabled', label: 'Enabled', description: 'Allow MCP server connections' },
  { value: 'Disabled', label: 'Disabled', description: 'Disable all MCP features' }
]

export function KiroSettingsPage() {
  const [settings, setSettings] = useState<KiroSettings>(defaultSettings)
  const [mcpConfig, setMcpConfig] = useState<McpConfig>({ mcpServers: {} })
  const [steeringFiles, setSteeringFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string; description: string }>>([])
  const [loadingModels, setLoadingModels] = useState(false)
  
  const [expandedSections, setExpandedSections] = useState({
    agent: true,
    mcp: true,
    steering: true,
    commands: false
  })

  const [newTrustedCommand, setNewTrustedCommand] = useState('')
  const [newTrustedToolName, setNewTrustedToolName] = useState('')
  const [newDenyCommand, setNewDenyCommand] = useState('')
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [editingMcp, setEditingMcp] = useState<{ name?: string; server?: McpServer } | null>(null)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const autonomyOptions = isEn ? autonomyOptionsEn : autonomyOptionsZh
  const mcpOptions = isEn ? mcpOptionsEn : mcpOptionsZh

  useEffect(() => {
    loadKiroSettings()
    loadAvailableModels()
  }, [])

  const loadAvailableModels = async () => {
    setLoadingModels(true)
    try {
      const result = await window.api.getKiroAvailableModels()
      if (result.models && result.models.length > 0) {
        setAvailableModels(result.models)
      }
    } catch (err) {
      console.error('Failed to load models:', err)
    } finally {
      setLoadingModels(false)
    }
  }

  const loadKiroSettings = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.getKiroSettings()
      if (result.settings) {
        // filter out undefined value to avoid overwriting the default value
        const filteredSettings = Object.fromEntries(
          Object.entries(result.settings).filter(([, v]) => v !== undefined)
        ) as Partial<KiroSettings>
        setSettings({ ...defaultSettings, ...filteredSettings })
      }
      if (result.mcpConfig) {
        setMcpConfig(result.mcpConfig as McpConfig)
      }
      if (result.steeringFiles) {
        setSteeringFiles(result.steeringFiles)
      }
    } catch (err) {
      setError(isEn ? 'Failed to load Kiro settings' : 'load Kiro Setup failed')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setError(null)
    try {
      await window.api.saveKiroSettings(settings as unknown as Record<string, unknown>)
    } catch (err) {
      setError(isEn ? 'Failed to save settings' : 'Failed to save settings')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  const openKiroSettingsFile = async () => {
    // Open Kiro settings.json document
    try {
      await window.api.openKiroSettingsFile()
    } catch (err) {
      console.error(err)
    }
  }

  const openMcpConfig = async (type: 'user' | 'workspace') => {
    try {
      await window.api.openKiroMcpConfig(type)
    } catch (err) {
      console.error(err)
    }
  }

  const openSteeringFolder = async () => {
    try {
      await window.api.openKiroSteeringFolder()
    } catch (err) {
      console.error(err)
    }
  }

  const openSteeringFile = (filename: string) => {
    setEditingFile(filename)
  }

  const openSteeringFileExternal = async (filename: string) => {
    try {
      await window.api.openKiroSteeringFile(filename)
    } catch (err) {
      console.error(err)
    }
  }

  const createDefaultRules = async () => {
    try {
      const result = await window.api.createKiroDefaultRules()
      if (result.success) {
        // Reload settings to get newly created files
        await loadKiroSettings()
      }
    } catch (err) {
      console.error(err)
    }
  }

  const deleteSteeringFile = async (filename: string) => {
    if (!confirm(isEn ? `Delete "${filename}"? This cannot be undone.` : `Confirm to delete "${filename}" ? This action cannot be undone.`)) {
      return
    }
    try {
      const result = await window.api.deleteKiroSteeringFile(filename)
      if (result.success) {
        await loadKiroSettings()
      } else {
        setError(result.error || (isEn ? 'Failed to delete file' : 'Failed to delete file'))
      }
    } catch (err) {
      console.error(err)
      setError(isEn ? 'Failed to delete file' : 'Failed to delete file')
    }
  }

  const deleteMcpServer = async (name: string) => {
    if (!confirm(isEn ? `Delete MCP server "${name}"?` : `Confirm to delete MCP server "${name}" ?`)) {
      return
    }
    try {
      const result = await window.api.deleteMcpServer(name)
      if (result.success) {
        await loadKiroSettings()
      } else {
        setError(result.error || (isEn ? 'Failed to delete server' : 'Failed to delete server'))
      }
    } catch (err) {
      console.error(err)
      setError(isEn ? 'Failed to delete server' : 'Failed to delete server')
    }
  }

  const addTrustedCommand = () => {
    if (newTrustedCommand.trim()) {
      setSettings(prev => ({
        ...prev,
        trustedCommands: [...prev.trustedCommands, newTrustedCommand.trim()]
      }))
      setNewTrustedCommand('')
    }
  }

  const removeTrustedCommand = (index: number) => {
    setSettings(prev => ({
      ...prev,
      trustedCommands: prev.trustedCommands.filter((_, i) => i !== index)
    }))
  }

  const addDenyCommand = () => {
    if (newDenyCommand.trim()) {
      setSettings(prev => ({
        ...prev,
        commandDenylist: [...prev.commandDenylist, newDenyCommand.trim()]
      }))
      setNewDenyCommand('')
    }
  }

  const addDefaultDenyCommands = () => {
    setSettings(prev => {
      // Filter out existing commands
      const newCommands = defaultDenyCommands.filter(
        cmd => !prev.commandDenylist.includes(cmd)
      )
      return {
        ...prev,
        commandDenylist: [...prev.commandDenylist, ...newCommands]
      }
    })
  }

  const removeDenyCommand = (index: number) => {
    setSettings(prev => ({
      ...prev,
      commandDenylist: prev.commandDenylist.filter((_, i) => i !== index)
    }))
  }

  if (loading) {
    return (
      <div className="flex-1 p-6 flex items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Page header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
              <Sparkles className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-primary">{isEn ? 'Kiro Settings' : 'Kiro set up'}</h1>
              <p className="text-muted-foreground">{isEn ? 'Manage Kiro IDE config, MCP servers and user rules' : 'manage Kiro IDE configuration,MCP Server and user rules'}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={loadKiroSettings} className="bg-background/50 backdrop-blur-sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              {isEn ? 'Refresh' : 'refresh'}
            </Button>
            <Button variant="outline" size="sm" onClick={openKiroSettingsFile} className="bg-background/50 backdrop-blur-sm">
              <ExternalLink className="h-4 w-4 mr-2" />
              {isEn ? 'Open File' : 'Open settings file'}
            </Button>
            <Button size="sm" onClick={saveSettings} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? (isEn ? 'Saving...' : 'Saving...') : (isEn ? 'Save' : 'Save settings')}
            </Button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-destructive/10 text-destructive rounded-lg">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Agent set up */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('agent')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Settings2 className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'Agent Settings' : 'Agent set up'}</span>
            </div>
            {expandedSections.agent ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.agent && (
          <CardContent className="space-y-4">
            {/* Agent Autonomy */}
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{isEn ? 'Agent Autonomy' : 'Agent autonomous mode'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Determines whether the agent will ask for accept/reject at each checkpoint in the workflow.' : 'Decide Agent Whether acceptance is required at each checkpoint in the workflow/reject'}</p>
              </div>
              <Select
                value={settings.agentAutonomy}
                options={autonomyOptions}
                onChange={(value) => setSettings(prev => ({ ...prev, agentAutonomy: value }))}
                className="w-[200px]"
              />
            </div>

            {/* Model Selection */}
            <div className="flex items-center justify-between border-t pt-4">
              <div className="flex-1 mr-4">
                <p className="font-medium">{isEn ? 'Model Selection' : 'Model selection'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Select model to use for agent operations.' : 'choose Agent The model used in the operation'}</p>
              </div>
              <div className="flex items-center gap-2">
                {availableModels.length > 0 ? (
                  <Select
                    value={settings.modelSelection}
                    options={availableModels.map(m => ({
                      value: m.id,
                      label: m.name || m.id,
                      description: m.description
                    }))}
                    onChange={(value) => setSettings(prev => ({ ...prev, modelSelection: value }))}
                    className="w-[240px]"
                  />
                ) : (
                  <input
                    type="text"
                    value={settings.modelSelection}
                    onChange={(e) => setSettings(prev => ({ ...prev, modelSelection: e.target.value }))}
                    placeholder="claude-haiku-4.5"
                    className="w-[240px] px-3 py-1.5 rounded-md border bg-background text-sm"
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadAvailableModels}
                  disabled={loadingModels}
                  title={isEn ? 'Refresh models' : 'Refresh model list'}
                >
                  <RefreshCw className={`h-4 w-4 ${loadingModels ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>

            {/* Toggle Options */}
            <div className="border-t pt-4 space-y-4">
              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Tab Autocomplete' : 'Tab autocomplete'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Tab Autocomplete allows Kiro Agent to provide code suggestions in the editor as you type.' : 'Tab Autocomplete allowed Kiro Agent Code suggestions as you type'}</p>
                </div>
                <Toggle
                  checked={settings.enableTabAutocomplete}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableTabAutocomplete: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Usage Summary' : 'usage statistics'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Display usage summary and elapsed time for agent executions.' : 'show Agent Usage summary and time taken to execute'}</p>
                </div>
                <Toggle
                  checked={settings.usageSummary}
                  onChange={(checked) => setSettings(prev => ({ ...prev, usageSummary: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Code References: Reference Tracker' : 'Code reference tracking'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Allow Kiro to generate code with code references. Sometimes code generated by Kiro may be similar to publicly available code.' : 'allow Kiro Generate code with code references.Kiro The generated code may be similar to publicly available code.'}</p>
                </div>
                <Toggle
                  checked={settings.codeReferences}
                  onChange={(checked) => setSettings(prev => ({ ...prev, codeReferences: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Codebase Indexing' : 'code base index'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Enable Repo Indexing (Experimental). This is an experimental feature which does not work with multi-folder workspaces.' : 'Enable warehouse indexing (experimental). This is an experimental feature and does not support multi-folder workspaces.'}</p>
                </div>
                <Toggle
                  checked={settings.enableCodebaseIndexing}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableCodebaseIndexing: checked }))}
                />
              </div>

              <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                <div>
                  <p className="font-medium">{isEn ? 'Enable Debug Logs' : 'debug log'}</p>
                  <p className="text-sm text-muted-foreground">{isEn ? 'Enable Kiro Debug Logs in the Output panel.' : 'Enable in output panel Kiro debug log'}</p>
                </div>
                <Toggle
                  checked={settings.enableDebugLogs}
                  onChange={(checked) => setSettings(prev => ({ ...prev, enableDebugLogs: checked }))}
                />
              </div>
            </div>

            {/* Notification settings */}
            <div className="border-t pt-4">
              <p className="font-medium mb-3">{isEn ? 'Notifications' : 'Notification settings'}</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Action Required' : 'Agent: Need operation'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notification when the agent requires input, e.g. for a shell command.' : 'Agent Display desktop notification when input is required, such as executing Shell When commanding'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsActionRequired}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsActionRequired: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Failure' : 'Agent: fail'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notification when the agent encounters an unexpected failure.' : 'Agent Display desktop notification when encountering unexpected failure'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsFailure}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsFailure: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Agent: Success' : 'Agent: success'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show desktop notifications when the agent successfully completes a task.' : 'Agent Show desktop notification when task completed successfully'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsSuccess}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsSuccess: checked }))}
                  />
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg hover:bg-muted/50 transition-colors">
                  <div>
                    <p className="font-medium">{isEn ? 'Billing' : 'bill'}</p>
                    <p className="text-sm text-muted-foreground">{isEn ? 'Show in-app notifications for billing and usage events (usage resets, low resources, overages).' : 'In-app notifications showing billing and usage events (usage resets, low resources, overage)'}</p>
                  </div>
                  <Toggle
                    checked={settings.notificationsBilling}
                    onChange={(checked) => setSettings(prev => ({ ...prev, notificationsBilling: checked }))}
                  />
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* MCP set up */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('mcp')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'MCP Servers' : 'MCP server'}</span>
              <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                {Object.keys(mcpConfig.mcpServers).length}
              </span>
            </div>
            {expandedSections.mcp ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.mcp && (
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">{isEn ? 'Enable MCP' : 'enable MCP'}</p>
                <p className="text-sm text-muted-foreground">{isEn ? 'Allow connections to external tools and data sources' : 'Allows connection to external tools and data sources'}</p>
              </div>
              <Select
                value={settings.configureMCP}
                options={mcpOptions}
                onChange={(value) => setSettings(prev => ({ ...prev, configureMCP: value }))}
              />
            </div>

            <div className="border-t pt-4">
              <p className="font-medium mb-2">{isEn ? 'Configured MCP Servers' : 'configured MCP server'}</p>
              {Object.keys(mcpConfig.mcpServers).length === 0 ? (
                <p className="text-sm text-muted-foreground">{isEn ? 'No MCP servers configured' : 'Not configured yet MCP server'}</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(mcpConfig.mcpServers).map(([name, server]) => (
                    <div key={name} className="flex items-center justify-between p-2 bg-muted rounded-md">
                      <div className="flex-1">
                        <p className="font-medium text-sm">{name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{server.command}</p>
                      </div>
                      <div className="flex gap-1">
                        <button
                          className="p-1 hover:bg-background rounded transition-colors"
                          onClick={() => setEditingMcp({ name, server })}
                          title={isEn ? 'Edit' : 'edit'}
                        >
                          <Edit className="h-4 w-4 text-primary" />
                        </button>
                        <button
                          className="p-1 hover:bg-background rounded transition-colors"
                          onClick={() => deleteMcpServer(name)}
                          title={isEn ? 'Delete' : 'delete'}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditingMcp({})}>
                <Plus className="h-4 w-4 mr-2" />
                {isEn ? 'Add MCP Server' : 'Add to MCP server'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('user')}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'User MCP Config' : 'user MCP Configuration'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => openMcpConfig('workspace')}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'Workspace MCP Config' : 'workspace MCP Configuration'}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Steering User rules */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('steering')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'User Rules (Steering)' : 'User rules (Steering)'}</span>
              <span className="px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary">
                {steeringFiles.length} {isEn ? 'files' : 'files'}
              </span>
            </div>
            {expandedSections.steering ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.steering && (
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isEn ? 'Steering files define AI assistant behavior rules and context' : 'Steering file used to define AI Behavior rules and context for assistants'}
            </p>

            {steeringFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{isEn ? 'No steering files' : 'None Steering document'}</p>
            ) : (
              <div className="space-y-2">
                {steeringFiles.map((file, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 bg-muted rounded-md"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-mono flex-1">{file}</span>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => openSteeringFile(file)}
                      title={isEn ? 'Edit internally' : 'Internal editor'}
                    >
                      <Edit className="h-4 w-4 text-primary" />
                    </button>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => openSteeringFileExternal(file)}
                      title={isEn ? 'Open externally' : 'Open externally'}
                    >
                      <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    </button>
                    <button
                      className="p-1 hover:bg-background rounded transition-colors"
                      onClick={() => deleteSteeringFile(file)}
                      title={isEn ? 'Delete' : 'delete'}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={createDefaultRules}>
                <Plus className="h-4 w-4 mr-2" />
                {isEn ? 'Create Rules' : 'Create rules file'}
              </Button>
              <Button variant="outline" size="sm" onClick={openSteeringFolder}>
                <FolderOpen className="h-4 w-4 mr-2" />
                {isEn ? 'Open Steering Folder' : 'Open Steering Table of contents'}
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Command settings */}
      <Card className="hover-lift">
        <CardHeader className="pb-2 cursor-pointer hover:bg-muted/30 transition-colors rounded-t-lg" onClick={() => toggleSection('commands')}>
          <CardTitle className="text-base flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Terminal className="h-4 w-4 text-primary" />
              </div>
              <span>{isEn ? 'Command Config' : 'Command configuration'}</span>
            </div>
            {expandedSections.commands ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </CardTitle>
        </CardHeader>
        {expandedSections.commands && (
          <CardContent className="space-y-6">
            {/* Trusted Commands */}
            <div className="p-4 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="h-4 w-4 text-primary" />
                <p className="font-medium">{isEn ? 'Trusted Commands' : 'trust command'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'These commands will auto-execute without confirmation' : 'These commands will be executed automatically without confirmation'}</p>
              <div className="space-y-2">
                {settings.trustedCommands.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeTrustedCommand(index)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTrustedCommand}
                    onChange={(e) => setNewTrustedCommand(e.target.value)}
                    placeholder={isEn ? 'e.g.: npm *' : 'like: npm *'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && addTrustedCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addTrustedCommand}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Trusted Tools */}
            <div className="p-4 rounded-lg bg-muted/50 border border-border">
              <div className="flex items-center gap-2 mb-3">
                <Zap className="h-4 w-4 text-primary" />
                <p className="font-medium">{isEn ? 'Trusted Tools' : 'Trusted Tools'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'Tools to auto-accept if requested by the Agent. Each tool name maps to a boolean indicating whether it should be trusted.' : 'when Agent Requests to use these tools are automatically approved. Each tool name corresponds to a Boolean value of whether it is trusted.'}</p>
              <div className="space-y-2">
                {Object.entries(settings.trustedTools).map(([name, trusted]) => (
                  <div key={name} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{name}</code>
                    <Toggle
                      checked={trusted}
                      onChange={(checked) => setSettings(prev => ({
                        ...prev,
                        trustedTools: { ...prev.trustedTools, [name]: checked }
                      }))}
                    />
                    <Button variant="ghost" size="sm" onClick={() => {
                      setSettings(prev => {
                        const tools = { ...prev.trustedTools }
                        delete tools[name]
                        return { ...prev, trustedTools: tools }
                      })
                    }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newTrustedToolName}
                    onChange={(e) => setNewTrustedToolName(e.target.value)}
                    placeholder={isEn ? 'Tool name' : 'Tool name'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newTrustedToolName.trim()) {
                        setSettings(prev => ({
                          ...prev,
                          trustedTools: { ...prev.trustedTools, [newTrustedToolName.trim()]: true }
                        }))
                        setNewTrustedToolName('')
                      }
                    }}
                  />
                  <Button variant="outline" size="sm" onClick={() => {
                    if (newTrustedToolName.trim()) {
                      setSettings(prev => ({
                        ...prev,
                        trustedTools: { ...prev.trustedTools, [newTrustedToolName.trim()]: true }
                      }))
                      setNewTrustedToolName('')
                    }
                  }}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Command Denylist */}
            <div className="p-4 rounded-lg bg-destructive/5 border border-destructive/20">
              <div className="flex items-center gap-2 mb-3">
                <AlertCircle className="h-4 w-4 text-destructive" />
                <p className="font-medium text-destructive">{isEn ? 'Blocked Commands' : 'forbidden order'}</p>
              </div>
              <p className="text-sm text-muted-foreground mb-3">{isEn ? 'These commands always require manual confirmation' : 'These commands always require manual confirmation'}</p>
              <div className="space-y-2">
                {settings.commandDenylist.map((cmd, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <code className="flex-1 px-2 py-1 bg-muted rounded text-sm">{cmd}</code>
                    <Button variant="ghost" size="sm" onClick={() => removeDenyCommand(index)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newDenyCommand}
                    onChange={(e) => setNewDenyCommand(e.target.value)}
                    placeholder={isEn ? 'e.g.: rm -rf *' : 'like: rm -rf *'}
                    className="flex-1 px-3 py-1.5 rounded-md border bg-background text-sm"
                    onKeyDown={(e) => e.key === 'Enter' && addDenyCommand()}
                  />
                  <Button variant="outline" size="sm" onClick={addDenyCommand}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={addDefaultDenyCommands}
                  className="mt-2"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  {isEn ? 'Add Default Blocked' : 'Add default forbidden command'}
                </Button>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Steering file editor */}
      {editingFile && (
        <SteeringEditor
          filename={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={loadKiroSettings}
        />
      )}

      {/* MCP Server Editor */}
      {editingMcp && (
        <McpServerEditor
          serverName={editingMcp.name}
          server={editingMcp.server}
          onClose={() => setEditingMcp(null)}
          onSaved={loadKiroSettings}
        />
      )}
    </div>
  )
}
