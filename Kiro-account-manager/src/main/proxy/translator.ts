// OpenAI/Claude Format and Kiro format converter
import { v4 as uuidv4 } from 'uuid'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAITool,
  OpenAIChatResponse,
  OpenAIStreamChunk,
  OpenAIResponsesRequest,
  OpenAIResponsesResponse,
  OpenAIResponseContentPart,
  OpenAIResponseOutputItem,
  ClaudeRequest,
  ClaudeMessage,
  ClaudeResponse,
  ClaudeStreamEvent,
  ClaudeContentBlock,
  KiroPayload,
  KiroHistoryMessage,
  KiroToolWrapper,
  KiroToolResult,
  KiroImage,
  KiroDocument,
  KiroToolUse,
  KiroUserInputMessage,
  KiroCachePoint,
  KiroReasoningContent,
  KiroUsage
} from './types'
import { buildKiroPayload, mapModelId } from './kiroApi'
import { ToolNameRegistry } from './toolNameRegistry'

const KIRO_CACHE_POINT: KiroCachePoint = { type: 'default' }

/** Model thinking Capability metadata (provided by proxyServer Passed in after querying from the model cache) */
export interface ThinkingConfig {
  schemaPath: 'output_config' | 'reasoning' | 'default'
  efforts: string[]
  defaultEffort?: string
}

function generateThinkingPrefix(
  clientThinking: { type: string; budget_tokens?: number; effort?: string } | undefined,
  clientReasoningEffort: string | undefined
): string | null {
  console.log('[DEBUG] ========== generateThinkingPrefix START ==========')
  console.log('[DEBUG] clientThinking:', JSON.stringify(clientThinking))
  console.log('[DEBUG] clientReasoningEffort:', clientReasoningEffort)

  if (clientThinking?.type === 'disabled') {
    return null
  }

  let thinkingPrefix: string | null = null

  if (clientThinking?.type === 'enabled') {
    let budget = Number(clientThinking.budget_tokens)
    if (!Number.isFinite(budget) || budget <= 0) budget = 32000
    budget = Math.floor(budget)
    if (budget < 1024) budget = 1024
    if (budget > 100000) budget = 100000
    thinkingPrefix = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
  } else if (clientThinking?.type === 'adaptive' || clientReasoningEffort || clientThinking?.effort) {
    const effortRaw = (clientReasoningEffort || clientThinking?.effort || 'high').toLowerCase().trim()
    const normalizedEffort = (effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high') ? effortRaw : 'high'
    thinkingPrefix = `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`
  }

  if (thinkingPrefix) {
    console.log(`[SUCCESS] generateThinkingPrefix: Generated XML: ${thinkingPrefix}`)
    try {
      require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `[${new Date().toISOString()}] Generated thinking XML: ${thinkingPrefix}\n`)
    } catch(e) {}
  }
  
  return thinkingPrefix
}

function toKiroCachePoint(cacheControl?: { type: string }): KiroCachePoint | undefined {
  if (!cacheControl) return undefined
  if (cacheControl.type !== 'ephemeral') {
    throw new Error(`Unsupported cache_control type: ${cacheControl.type}`)
  }
  return KIRO_CACHE_POINT
}

function mergeCachePoint(
  first?: KiroCachePoint,
  second?: KiroCachePoint
): KiroCachePoint | undefined {
  return first || second
}

export function responsesToOpenAIChat(request: OpenAIResponsesRequest): OpenAIChatRequest {
  if (!request || typeof request !== 'object') {
    throw new Error('Responses request body must be an object')
  }
  if (!request.model) {
    throw new Error('Responses request requires model')
  }
  if (request.input === undefined) {
    throw new Error('Responses request requires input')
  }

  const messages: OpenAIMessage[] = []
  if (request.instructions) {
    messages.push({ role: 'system', content: request.instructions })
  }
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input })
  } else {
    if (!Array.isArray(request.input)) {
      throw new Error('Responses input must be a string or an array')
    }
    for (const item of request.input) {
      const itemType = item.type as string | undefined
      if (itemType === 'function_call_output') {
        if (!item.call_id) {
          throw new Error('function_call_output requires call_id')
        }
        if (item.output === undefined) {
          throw new Error('function_call_output requires output')
        }
        messages.push({
          role: 'tool',
          content: item.output,
          tool_call_id: item.call_id
        })
      } else if (itemType === 'function_call') {
        if (!item.call_id) {
          throw new Error('function_call requires call_id')
        }
        if (!item.name) {
          throw new Error('function_call requires name')
        }
        if (item.arguments === undefined) {
          throw new Error('function_call requires arguments')
        }
        messages.push({
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: item.call_id,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments
            }
          }]
        })
      } else {
        if (itemType !== undefined && itemType !== 'message') {
          throw new Error(`Unsupported responses input item type: ${itemType}`)
        }
        if (item.content === undefined) {
          throw new Error('message input item requires content')
        }
        messages.push({
          role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user',
          content: convertResponseInputContent(item.content)
        })
      }
    }
  }

  const chatRequest: OpenAIChatRequest = {
    model: request.model,
    messages
  }
  if (request.temperature !== undefined) chatRequest.temperature = request.temperature
  if (request.top_p !== undefined) chatRequest.top_p = request.top_p
  if (request.max_output_tokens !== undefined) chatRequest.max_tokens = request.max_output_tokens
  if (request.stream !== undefined) chatRequest.stream = request.stream
  if (request.tools !== undefined) chatRequest.tools = request.tools
  const toolChoice = convertResponseToolChoice(request.tool_choice)
  if (toolChoice !== undefined) chatRequest.tool_choice = toolChoice
  if (request.previous_response_id !== undefined) chatRequest.conversation_id = request.previous_response_id
  if (request.metadata !== undefined) chatRequest.metadata = request.metadata
  if (request.kiro_context !== undefined) chatRequest.kiro_context = request.kiro_context
  return chatRequest
}

function convertResponseInputContent(content: string | OpenAIResponseContentPart[] | undefined): OpenAIMessage['content'] {
  if (typeof content === 'string') return content
  if (content === undefined) return ''
  if (!Array.isArray(content)) {
    throw new Error('message content must be a string or an array')
  }
  return content.map(part => {
    const partType = part.type as string
    if (partType === 'input_image') {
      if (!part.image_url) {
        throw new Error('input_image requires image_url')
      }
      return { type: 'image_url', image_url: { url: part.image_url } }
    }
    if (partType === 'input_file') {
      if (!part.file_data) {
        throw new Error('input_file requires file_data')
      }
      return {
        type: 'file',
        file: {
          file_data: part.file_data,
          ...(part.filename !== undefined ? { filename: part.filename } : {})
        }
      }
    }
    if (partType !== 'input_text' && partType !== 'output_text') {
      throw new Error(`Unsupported responses content part type: ${partType}`)
    }
    if (part.text === undefined) {
      throw new Error(`${partType} requires text`)
    }
    return { type: 'text', text: part.text }
  })
}

function convertResponseToolChoice(toolChoice: OpenAIResponsesRequest['tool_choice']): OpenAIChatRequest['tool_choice'] {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') return toolChoice
  if (toolChoice.type === 'none' || toolChoice.type === 'auto' || toolChoice.type === 'required') return toolChoice.type
  if (toolChoice.type === 'function' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  if (toolChoice.function?.name) return { type: 'function', function: { name: toolChoice.function.name } }
  return undefined
}

export function openAIChatToResponsesResponse(
  response: OpenAIChatResponse,
  previousResponseId?: string
): OpenAIResponsesResponse {
  const output: OpenAIResponseOutputItem[] = response.choices.flatMap<OpenAIResponseOutputItem>(choice => {
    if (choice.message.tool_calls?.length) {
      return choice.message.tool_calls.map(toolCall => ({
        type: 'function_call' as const,
        id: `fc_${uuidv4()}`,
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      }))
    }
    return [{
      type: 'message' as const,
      id: `msg_${uuidv4()}`,
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text: choice.message.content || '' }]
    }]
  })

  const usage: OpenAIResponsesResponse['usage'] = {
    input_tokens: response.usage.prompt_tokens,
    output_tokens: response.usage.completion_tokens,
    total_tokens: response.usage.total_tokens
  }
  const cachedTokens = response.usage.prompt_tokens_details?.cached_tokens
  if (cachedTokens !== undefined) {
    usage.input_tokens_details = { cached_tokens: cachedTokens }
  }
  const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens
  if (reasoningTokens !== undefined) {
    usage.output_tokens_details = { reasoning_tokens: reasoningTokens }
  }

  const responsesResponse: OpenAIResponsesResponse = {
    id: `resp_${uuidv4()}`,
    object: 'response',
    created_at: response.created,
    model: response.model,
    output,
    usage
  }
  if (previousResponseId !== undefined) {
    responsesResponse.previous_response_id = previousResponseId
  }
  return responsesResponse
}

// ============ OpenAI -> Kiro Convert ============

export function openaiToKiro(
  request: OpenAIChatRequest,
  profileArn?: string,
  toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
  _thinkingConfig?: ThinkingConfig
): KiroPayload {
  const modelId = mapModelId(request.model)
  const origin = 'AI_EDITOR'

  // Extract system prompts
  let systemPrompt = ''
  let systemCachePoint: KiroCachePoint | undefined
  const nonSystemMessages: OpenAIMessage[] = []

  for (const msg of request.messages) {
    if (msg.role === 'system') {
      systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(msg.cache_control))
      if (typeof msg.content === 'string') {
        systemPrompt += (systemPrompt ? '\n' : '') + msg.content
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(part.cache_control))
          if (part.type === 'text' && part.text) {
            systemPrompt += (systemPrompt ? '\n' : '') + part.text
          }
        }
      }
    } else {
      nonSystemMessages.push(msg)
    }
  }

  // Inject timestamp
  const timestamp = new Date().toISOString()
  systemPrompt = `[Context: Current time is ${timestamp}]\n\n${systemPrompt}`

  // Inject execution-directed instructions (prevent AI Lost target during exploration)
  const executionDirective = `
<execution_discipline>
When a user asks for a specific task, you must follow these disciplines:
1. **Targeting**: Keep the user’s original goals in mind throughout the session and don’t get lost in the code exploration process
2. **Action first**: Prioritize task execution rather than just analysis or summary, unless the user explicitly requests only analysis
3. **Plan execution**: Create a clear step-by-step plan for tasks, execute them step by step and mark completion status
4. **Confirmatory closing prohibited**: Disable output before the task is completed"Do you need me to continue?"、"Need a deeper analysis?"Waiting for confirmation questions
5. **Continue to advance**: If it is found that some tasks have been completed, immediately continue to execute the remaining unfinished tasks.
6. **Complete delivery**: The task is not complete until all task steps have been executed.
</execution_discipline>
`
  systemPrompt = systemPrompt + '\n\n' + executionDirective

  // Build history messages (reference Proxycast accomplish)
  const history: KiroHistoryMessage[] = []
  const toolResults: KiroToolResult[] = []
  let currentContent = ''
  let currentCachePoint: KiroCachePoint | undefined
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []
  for (let i = 0; i < nonSystemMessages.length; i++) {
    const msg = nonSystemMessages[i]
    const isLast = i === nonSystemMessages.length - 1

    if (msg.role === 'user') {
      const { content: userContent, images: userImages, documents: userDocuments, cachePoint } = extractOpenAIContent(msg)
      
      const mergedContent = userContent || 'Continue'
      const messageCachePoint = cachePoint
      
      if (isLast) {
        currentContent = mergedContent
        currentCachePoint = messageCachePoint
        images.push(...userImages)
        documents.push(...userDocuments)
      } else {
        history.push({
          userInputMessage: {
            content: mergedContent,
            modelId,
            origin,
            images: userImages.length > 0 ? userImages : undefined,
            documents: userDocuments.length > 0 ? userDocuments : undefined,
            ...(messageCachePoint ? { cachePoint: messageCachePoint } : {})
          }
        })
      }
    } else if (msg.role === 'assistant') {
      // Kiro API Require content Not empty
      // Notice: intentionally not read msg.reasoning_content (history Not passed Kiro)
      // Kiro rear end schema Only supported in response output assistantResponseMessage.reasoningContent，
      // in request history Passing this field in will trigger 400 "Improperly formed request"
      let assistantContent = typeof msg.content === 'string' ? msg.content : ''
      if (!assistantContent.trim() && msg.tool_calls && msg.tool_calls.length > 0) {
        assistantContent = ' '
      } else if (!assistantContent.trim()) {
        assistantContent = 'I understand.'
      }
      const toolUses: KiroToolUse[] = []

      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === 'function') {
            let input = {}
            try {
              input = JSON.parse(tc.function.arguments)
            } catch { /* ignore */ }
            toolUses.push({
              toolUseId: tc.id,
              name: toolNameRegistry.toKiroName(tc.function.name),
              input
            })
          }
        }
      }

      history.push({
        assistantResponseMessage: {
          content: assistantContent,
          toolUses: toolUses.length > 0 ? toolUses : undefined
        }
      })
    } else if (msg.role === 'tool') {
      // Tool result - Collect to be processed list
      if (msg.tool_call_id) {
        let rawText = ''
        let extractedImageCount = 0
        // content When it is an array (some clients put the image/Multimodal results hang here):
        // Extract all text Blocks are spliced ​​into text;image_url Blocks are extracted to the outer layer images, to avoid being JSON.stringify serialization lost
        if (Array.isArray(msg.content)) {
          const textParts: string[] = []
          for (const part of msg.content) {
            if (part.type === 'text' && typeof part.text === 'string') {
              textParts.push(part.text)
            } else if (part.type === 'image_url' && part.image_url?.url) {
              const img = parseImageUrl(part.image_url.url)
              if (img) { images.push(img); extractedImageCount++ }
            }
          }
          rawText = textParts.join('')
          if (!rawText && extractedImageCount === 0) {
            // Degenerate: convert unrecognized structures into stringify Let the model see at least the original structure
            rawText = JSON.stringify(msg.content)
          }
          if (extractedImageCount > 0) {
            rawText = (rawText ? rawText + '\n\n' : '') +
              `[Tool returned ${extractedImageCount} image${extractedImageCount > 1 ? 's' : ''}, attached to this message]`
          }
        } else {
          rawText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        }
        toolResults.push({
          toolUseId: msg.tool_call_id,
          content: [{ text: rawText || '(no output)' }],
          status: 'success'
        })
      }
      
      // Check next message: if not tool The message may have reached the end and will be collected toolResults Add as user information
      const nextMsg = nonSystemMessages[i + 1]
      const shouldFlush = !nextMsg || nextMsg.role !== 'tool'
      
      if (shouldFlush && toolResults.length > 0 && !isLast) {
        // Will toolResults as user message added to history
        history.push({
          userInputMessage: {
            content: 'Tool results provided.',
            modelId,
            origin,
            userInputMessageContext: {
              toolResults: [...toolResults]
            }
          }
        })
        // Clear processed toolResults
        toolResults.length = 0
      }
    }
  }

  // If the last item is assistant Message, sent automatically Continue(refer to Proxycast）
  if (history.length > 0 && history[history.length - 1].assistantResponseMessage && !currentContent) {
    currentContent = 'Continue.'
  }

  // If there is no current content but there are tool results (from the last round), keep them and pass them to currentMessage
  if (!currentContent && toolResults.length > 0) {
    currentContent = 'Tool results provided.'
  }

  // Inject thinking config as XML tags in system prompt
  const thinkingPrefix = generateThinkingPrefix(
    request.thinking as { type: string; budget_tokens?: number },
    request.reasoning_effort
  )
  
  if (thinkingPrefix) {
    systemPrompt = systemPrompt ? `${thinkingPrefix}\n${systemPrompt}` : thinkingPrefix
  }

  // System prompt by Kiro Official way to inject: as Human/AI pair Insert into history head
  if (systemPrompt) {
    const systemMessages: KiroHistoryMessage[] = [
      {
        userInputMessage: {
          content: systemPrompt,
          userInputMessageContext: {},
          origin,
          ...(systemCachePoint ? { cachePoint: systemCachePoint } : {})
        }
      },
      {
        assistantResponseMessage: {
          content: 'I will follow these instructions.'
        }
      }
    ]
    history.unshift(...systemMessages)
  }
  const finalContent = currentContent || 'Continue.'

  // Conversion tool definition
  const kiroTools = convertOpenAITools(request.tools, toolNameRegistry)

  return buildKiroPayload(
    finalContent,
    modelId,
    origin,
    history,
    kiroTools,
    toolResults,
    images,
    profileArn,
    {
      maxTokens: request.max_tokens,
      temperature: request.temperature,
      topP: request.top_p
    },
    {
      cachePoint: currentCachePoint,
      documents,
      conversationId: request.conversation_id,
      context: request.kiro_context
    }
  )
}

function extractOpenAIContent(msg: OpenAIMessage): { content: string; images: KiroImage[]; documents: KiroDocument[]; cachePoint?: KiroCachePoint } {
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []
  let content = ''
  let cachePoint = toKiroCachePoint(msg.cache_control)

  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      cachePoint = mergeCachePoint(cachePoint, toKiroCachePoint(part.cache_control))
      if (part.type === 'text' && part.text) {
        content += part.text
      } else if (part.type === 'image_url' && part.image_url?.url) {
        const image = parseImageUrl(part.image_url.url)
        if (image) {
          images.push(image)
        }
      } else if (part.type === 'file' || part.type === 'document') {
        if (part.file?.file_data) {
          const name = part.file.filename || part.name
          if (!name) {
            throw new Error(`${part.type} requires filename or name`)
          }
          documents.push(parseOpenAIFileData(part.file.file_data, name))
        } else if (part.source) {
          if (!part.name) {
            throw new Error(`${part.type} requires name`)
          }
          documents.push(parseClaudeDocumentSource(part.source, part.name))
        } else {
          throw new Error(`${part.type} requires file_data or source`)
        }
      }
    }
  }

  return { content, images, documents, cachePoint }
}

// Parse images URL(support data URL and HTTP URL）
function parseImageUrl(url: string): KiroImage | null {
  if (url.startsWith('data:')) {
    // parse data URL: data:image/png;base64,xxxxx
    const match = url.match(/^data:image\/(\w+);base64,(.+)$/)
    if (match) {
      return {
        format: normalizeImageFormat(match[1]),
        source: { bytes: match[2] }
      }
    }
  }
  return null
}

function parseOpenAIFileData(fileData: string, name: string): KiroDocument {
  const dataUrlMatch = fileData.match(/^data:([^;]+);base64,(.+)$/)
  if (dataUrlMatch) {
    return {
      format: normalizeDocumentFormat(dataUrlMatch[1], name),
      name,
      source: { bytes: dataUrlMatch[2] }
    }
  }

  return {
    format: normalizeDocumentFormat(undefined, name),
    name,
    source: { bytes: fileData }
  }
}

function parseClaudeDocumentSource(source: NonNullable<ClaudeContentBlock['source']>, name: string): KiroDocument {
  if (source.type === 'base64') {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: source.data }
    }
  }
  if (source.type === 'text') {
    return {
      format: normalizeDocumentFormat(source.media_type, name),
      name,
      source: { bytes: Buffer.from(source.data, 'utf8').toString('base64') }
    }
  }
  throw new Error(`Unsupported document source type: ${source.type}`)
}

// Standardized image format
function normalizeImageFormat(format: string): string {
  const lower = format.toLowerCase()
  const formatMap: Record<string, string> = {
    'jpg': 'jpeg',
    'jpeg': 'jpeg',
    'png': 'png',
    'gif': 'gif',
    'webp': 'webp'
  }
  const normalized = formatMap[lower]
  if (!normalized) {
    throw new Error(`Unsupported image format: ${format}`)
  }
  return normalized
}

function normalizeDocumentFormat(mediaType: string | undefined, name: string): string {
  const lowerMediaType = mediaType?.toLowerCase()
  if (lowerMediaType === 'application/pdf') return 'pdf'
  if (lowerMediaType === 'text/markdown') return 'md'
  if (lowerMediaType === 'text/csv') return 'csv'
  if (lowerMediaType === 'text/html') return 'html'
  if (lowerMediaType?.startsWith('text/')) return 'txt'
  const extension = name.split('.').pop()?.toLowerCase()
  if (extension === 'pdf') return 'pdf'
  if (extension === 'md' || extension === 'markdown') return 'md'
  if (extension === 'csv') return 'csv'
  if (extension === 'html' || extension === 'htm') return 'html'
  return 'txt'
}


// Kiro API tool description maximum length
const KIRO_MAX_TOOL_DESC_LEN = 10237 // set aside "..." space

function convertOpenAITools(
  tools: OpenAITool[] | undefined,
  toolNameRegistry: ToolNameRegistry
): KiroToolWrapper[] {
  if (!tools) return []

  return tools.flatMap(tool => {
    let description = tool.function.description || `Tool: ${tool.function.name}`
    // Truncate too long descriptions
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
      description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + '...'
    }
    const kiroTool: KiroToolWrapper = {
      toolSpecification: {
        name: shortenToolName(tool.function.name, toolNameRegistry),
        description,
        inputSchema: { json: tool.function.parameters }
      }
    }
    const cachePoint = toKiroCachePoint(tool.cache_control)
    return cachePoint ? [kiroTool, { cachePoint }] : [kiroTool]
  })
}

function shortenToolName(name: string, toolNameRegistry: ToolNameRegistry): string {
  return toolNameRegistry.toKiroName(name)
}

// ============ Kiro -> OpenAI Convert ============

export function kiroToOpenaiResponse(
  content: string,
  toolUses: KiroToolUse[],
  usage: KiroUsage,
  model: string,
  toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
  reasoningContent?: { text?: string; signature?: string; redactedContent?: string }
): OpenAIChatResponse {
  const restoredToolUses = toolNameRegistry.restoreToolUses(toolUses)
  const openaiUsage: OpenAIChatResponse['usage'] = {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens
  }
  if (usage.cacheReadTokens) {
    openaiUsage.prompt_tokens_details = {
      cached_tokens: usage.cacheReadTokens
    }
  }
  if (usage.reasoningTokens) {
    openaiUsage.completion_tokens_details = {
      reasoning_tokens: usage.reasoningTokens
    }
  }
  const response: OpenAIChatResponse = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: (restoredToolUses.length > 0 || !content?.trim()) ? null : content,
        ...(reasoningContent?.text ? { reasoning_content: reasoningContent.text } : {}),
        tool_calls: restoredToolUses.length > 0 ? restoredToolUses.map(tu => ({
          id: tu.toolUseId,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input)
          }
        })) : undefined
      },
      finish_reason: restoredToolUses.length > 0 ? 'tool_calls' : 'stop'
    }],
    usage: openaiUsage
  }

  return response
}

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

export function createOpenaiStreamChunk(
  id: string,
  model: string,
  delta: { role?: 'assistant'; content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }[] },
  finishReason: 'stop' | 'tool_calls' | null = null,
  usage?: OpenAIUsage
): OpenAIStreamChunk & { usage?: OpenAIUsage } {
  const chunk: OpenAIStreamChunk & { usage?: OpenAIUsage } = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: delta as OpenAIStreamChunk['choices'][0]['delta'],
      finish_reason: finishReason
    }]
  }
  if (usage) {
    chunk.usage = usage
  }
  return chunk
}

// ============ Claude -> Kiro Convert ============

export function claudeToKiro(
  request: ClaudeRequest,
  profileArn?: string,
  toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
  _thinkingConfig?: ThinkingConfig
): KiroPayload {
  const modelId = mapModelId(request.model)
  const origin = 'AI_EDITOR'

  // Extract system prompts
  let systemPrompt = ''
  let systemCachePoint: KiroCachePoint | undefined
  if (typeof request.system === 'string') {
    systemPrompt = request.system
  } else if (Array.isArray(request.system)) {
    systemPrompt = request.system.map(b => {
      systemCachePoint = mergeCachePoint(systemCachePoint, toKiroCachePoint(b.cache_control))
      return b.text
    }).join('\n')
  }

  // Inject timestamp
  const timestamp = new Date().toISOString()
  systemPrompt = `[Context: Current time is ${timestamp}]\n\n${systemPrompt}`

  // Inject execution-directed instructions (prevent AI Lost target during exploration)
  const executionDirective = `
<execution_discipline>
When a user asks for a specific task, you must follow these disciplines:
1. **Targeting**: Keep the user’s original goals in mind throughout the session and don’t get lost in the code exploration process
2. **Action first**: Prioritize task execution rather than just analysis or summary, unless the user explicitly requests only analysis
3. **Plan execution**: Create a clear step-by-step plan for tasks, execute them step by step and mark completion status
4. **Confirmatory closing prohibited**: Disable output before the task is completed"Do you need me to continue?"、"Need a deeper analysis?"Waiting for confirmation questions
5. **Continue to advance**: If it is found that some tasks have been completed, immediately continue to execute the remaining unfinished tasks.
6. **Complete delivery**: The task is not complete until all task steps have been executed.
</execution_discipline>
`
  systemPrompt = systemPrompt + '\n\n' + executionDirective

  // Build historical messages - Kiro API demanding user -> assistant alternately
  const history: KiroHistoryMessage[] = []
  let currentToolResults: KiroToolResult[] = []  // Only save the last message toolResults
  let currentContent = ''
  let currentCachePoint: KiroCachePoint | undefined
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []

  // Temporary storage, used to merge consecutive messages of the same type
  let pendingUserContent = ''
  let pendingUserImages: KiroImage[] = []
  let pendingUserDocuments: KiroDocument[] = []
  let pendingToolResults: KiroToolResult[] = []
  let pendingUserCachePoint: KiroCachePoint | undefined

  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i]
    const isLast = i === request.messages.length - 1

    if (msg.role === 'user') {
      const { content: userContent, images: userImages, documents: userDocuments, toolResults: userToolResults, cachePoint: userCachePoint } = extractClaudeContent(msg)

      if (isLast) {
        // Last message: before merge pending content,toolResults put in currentMessage
        currentContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
        images.push(...pendingUserImages, ...userImages)
        documents.push(...pendingUserDocuments, ...userDocuments)
        currentToolResults = [...pendingToolResults, ...userToolResults]
        currentCachePoint = mergeCachePoint(pendingUserCachePoint, userCachePoint)
        pendingUserContent = ''
        pendingUserImages = []
        pendingUserDocuments = []
        pendingToolResults = []
        pendingUserCachePoint = undefined
      } else {
        // Not the last item: Check if the next item is assistant
        const nextMsg = request.messages[i + 1]
        if (nextMsg && nextMsg.role === 'assistant') {
          // The next item is assistant, can be safely added to history
          const finalUserContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
          const finalUserImages = [...pendingUserImages, ...userImages]
          const finalUserDocuments = [...pendingUserDocuments, ...userDocuments]
          const finalToolResults = [...pendingToolResults, ...userToolResults]
          const finalCachePoint = mergeCachePoint(pendingUserCachePoint, userCachePoint)
          
          if (finalUserContent.trim() || finalUserImages.length > 0 || finalUserDocuments.length > 0 || finalToolResults.length > 0) {
            const userInputMessage: KiroUserInputMessage = {
              content: finalUserContent || (finalToolResults.length > 0 ? 'Tool results provided.' : 'Continue'),
              modelId,
              origin,
              images: finalUserImages.length > 0 ? finalUserImages : undefined,
              documents: finalUserDocuments.length > 0 ? finalUserDocuments : undefined,
              ...(finalCachePoint ? { cachePoint: finalCachePoint } : {})
            }
            // if there is toolResults, put in userInputMessageContext
            if (finalToolResults.length > 0) {
              userInputMessage.userInputMessageContext = {
                toolResults: finalToolResults
              }
            }
            history.push({ userInputMessage })
          }
          pendingUserContent = ''
          pendingUserImages = []
          pendingUserDocuments = []
          pendingToolResults = []
          pendingUserCachePoint = undefined
        } else {
          // The next one is not assistant(possibly consecutive user or end), cumulative content
          pendingUserContent = pendingUserContent ? pendingUserContent + '\n' + userContent : userContent
          pendingUserImages.push(...userImages)
          pendingUserDocuments.push(...userDocuments)
          pendingToolResults.push(...userToolResults)
          pendingUserCachePoint = mergeCachePoint(pendingUserCachePoint, userCachePoint)
        }
      }
    } else if (msg.role === 'assistant') {
      // Notice: deliberately discarded reasoningContent (history Not passed Kiro)
      // Kiro rear end schema Only supported in response output assistantResponseMessage.reasoningContent，
      // in request history Passing this field in will trigger 400 "Improperly formed request"
      // of current news thinking The switch consists of additionalModelRequestFields.thinking control
      const { content: assistantContent, toolUses } = extractClaudeAssistantContent(msg, toolNameRegistry)

      // if there is pending of user content but not added yet history, add first
      if (pendingUserContent.trim() || pendingUserImages.length > 0 || pendingUserDocuments.length > 0 || pendingToolResults.length > 0) {
        const userInputMessage: KiroUserInputMessage = {
          content: pendingUserContent || (pendingToolResults.length > 0 ? 'Tool results provided.' : 'Continue'),
          modelId,
          origin,
          images: pendingUserImages.length > 0 ? pendingUserImages : undefined,
          documents: pendingUserDocuments.length > 0 ? pendingUserDocuments : undefined,
          ...(pendingUserCachePoint ? { cachePoint: pendingUserCachePoint } : {})
        }
        if (pendingToolResults.length > 0) {
          userInputMessage.userInputMessageContext = {
            toolResults: pendingToolResults
          }
        }
        history.push({ userInputMessage })
        pendingUserContent = ''
        pendingUserImages = []
        pendingUserDocuments = []
        pendingToolResults = []
        pendingUserCachePoint = undefined
      }

      const assistantResponseMessage = {
        content: assistantContent,
        ...(toolUses.length > 0 ? { toolUses } : {})
      }
      history.push({ assistantResponseMessage })
    }
  }

  // dispose of remaining pending Content (if the last few items are all user and not isLast）
  if (pendingUserContent.trim() || pendingUserImages.length > 0 || pendingUserDocuments.length > 0 || pendingToolResults.length > 0) {
    currentContent = pendingUserContent + (currentContent ? '\n' + currentContent : '')
    images.unshift(...pendingUserImages)
    documents.unshift(...pendingUserDocuments)
    currentToolResults = [...pendingToolResults, ...currentToolResults]
    currentCachePoint = mergeCachePoint(pendingUserCachePoint, currentCachePoint)
  }

  // make sure history by user start(Kiro API Require)
  // if history by assistant To start, insert an empty user information
  if (history.length > 0 && history[0].assistantResponseMessage) {
    history.unshift({
      userInputMessage: {
        content: 'Begin conversation',
        modelId,
        origin
      }
    })
  }

  // Inject thinking config as XML tags in system prompt
  const thinkingPrefix = generateThinkingPrefix(
    request.thinking as { type: string; budget_tokens?: number; display?: string },
    undefined
  )
  
  if (thinkingPrefix) {
    systemPrompt = systemPrompt ? `${thinkingPrefix}\n${systemPrompt}` : thinkingPrefix
  }

  // Build final content
  // System prompt by Kiro Official way to inject: as Human/AI pair Insert into history head
  // official Kiro IDE: [Human(systemPrompt, forcedRole), AI("I will follow these instructions.", forcedRole)]
  if (systemPrompt) {
    const systemMessages: KiroHistoryMessage[] = [
      {
        userInputMessage: {
          content: systemPrompt,
          userInputMessageContext: {},
          origin,
          ...(systemCachePoint ? { cachePoint: systemCachePoint } : {})
        }
      },
      {
        assistantResponseMessage: {
          content: 'I will follow these instructions.'
        }
      }
    ]
    history.unshift(...systemMessages)
  }
  const finalContent = currentContent || (currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue')

  // Conversion tool definition
  const kiroTools = convertClaudeTools(request.tools, toolNameRegistry)

  return buildKiroPayload(
    finalContent,
    modelId,
    origin,
    history,
    kiroTools,
    currentToolResults,
    images,
    profileArn,
    {
      maxTokens: request.max_tokens,
      temperature: request.temperature,
      topP: request.top_p
    },
    {
      cachePoint: currentCachePoint,
      documents,
      conversationId: request.conversation_id,
      context: request.kiro_context
    }
  )
}

function extractClaudeContent(msg: ClaudeMessage): { content: string; images: KiroImage[]; documents: KiroDocument[]; toolResults: KiroToolResult[]; cachePoint?: KiroCachePoint } {
  const images: KiroImage[] = []
  const documents: KiroDocument[] = []
  const toolResults: KiroToolResult[] = []
  let content = ''
  let cachePoint = toKiroCachePoint(msg.cache_control)

  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      cachePoint = mergeCachePoint(cachePoint, toKiroCachePoint(block.cache_control))
      if (block.type === 'text' && block.text) {
        content += block.text
      } else if (block.type === 'image' && block.source?.type === 'base64') {
        const mediaTypeParts = block.source.media_type.split('/')
        const imageFormat = mediaTypeParts[1]
        if (mediaTypeParts[0] !== 'image' || !imageFormat) {
          throw new Error(`Unsupported image media_type: ${block.source.media_type}`)
        }
        images.push({
          format: normalizeImageFormat(imageFormat),
          source: { bytes: block.source.data }
        })
      } else if (block.type === 'document' && block.source) {
        if (!block.name) {
          throw new Error('document requires name')
        }
        documents.push(parseClaudeDocumentSource(block.source, block.name))
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        let resultContent = ''
        // Kiro tool_result.content Only supports text, but the user layer images Can host pictures.
        // put inline image block Extract to outer layer images, to avoid scene image content such as "reading local images" from being silently discarded.
        let extractedImageCount = 0
        if (typeof block.content === 'string') {
          resultContent = block.content || '(empty)'
        } else if (Array.isArray(block.content)) {
          const textParts: string[] = []
          for (const b of block.content) {
            if (b.type === 'text') {
              textParts.push(b.text || '')
            } else if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) {
              const mediaTypeParts = (b.source.media_type || '').split('/')
              const imageFormat = mediaTypeParts[1]
              if (mediaTypeParts[0] === 'image' && imageFormat) {
                try {
                  images.push({
                    format: normalizeImageFormat(imageFormat),
                    source: { bytes: b.source.data }
                  })
                  extractedImageCount++
                } catch {
                  // Unsupported format: skip but don't throw an error (keep old behavior, avoid whole round failure)
                }
              }
            }
          }
          resultContent = textParts.join('')
          if (!resultContent) {
            resultContent = extractedImageCount > 0
              ? `(tool returned ${extractedImageCount} image${extractedImageCount > 1 ? 's' : ''}, attached to this message)`
              : '(no text output)'
          } else if (extractedImageCount > 0) {
            // Both text and pictures: prompt at the end of the text that the model has pictures attached
            resultContent += `\n\n[Tool also returned ${extractedImageCount} image${extractedImageCount > 1 ? 's' : ''}, attached to this message]`
          }
        } else if (block.content === undefined || block.content === null) {
          resultContent = '(no output)'
        } else {
          resultContent = String(block.content) || '(empty)'
        }
        toolResults.push({
          toolUseId: block.tool_use_id,
          content: [{ text: resultContent }],
          status: 'success'
        })
      }
    }
  }

  return { content, images, documents, toolResults, cachePoint }
}

function extractClaudeAssistantContent(
  msg: ClaudeMessage,
  toolNameRegistry: ToolNameRegistry
): { content: string; toolUses: KiroToolUse[]; reasoningContent?: KiroReasoningContent } {
  const toolUses: KiroToolUse[] = []
  let content = ''
  let thinking = ''
  let signature: string | undefined
  let redactedContent: string | undefined

  if (typeof msg.content === 'string') {
    content = msg.content
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'text' && block.text) {
        content += block.text
      } else if (block.type === 'thinking' && block.thinking) {
        thinking += block.thinking
        signature = block.signature || signature
      } else if (block.type === 'redacted_thinking' && block.data) {
        // redacted_thinking It is the encrypted thinking content and should be kept as it is.
        redactedContent = (redactedContent || '') + block.data
      } else if (block.type === 'tool_use' && block.id && block.name) {
        if (!block.input || typeof block.input !== 'object' || Array.isArray(block.input)) {
          throw new Error(`tool_use requires object input: ${block.name}`)
        }
        toolUses.push({
          toolUseId: block.id,
          name: toolNameRegistry.toKiroName(block.name),
          input: block.input as Record<string, unknown>
        })
      }
    }
  }

  // Kiro API Require content Not empty
  if (!content.trim() && toolUses.length > 0) {
    content = ' '
  }

  if (thinking || redactedContent) {
    const reasoningContent: KiroReasoningContent = {}
    if (thinking) {
      reasoningContent.reasoningText = signature ? { text: thinking, signature } : { text: thinking }
    }
    if (redactedContent) {
      reasoningContent.redactedContent = redactedContent
    }
    return { content, toolUses, reasoningContent }
  }

  return { content, toolUses }
}

function convertClaudeTools(
  tools: { name: string; description: string; input_schema: unknown; cache_control?: { type: string } }[] | undefined,
  toolNameRegistry: ToolNameRegistry
): KiroToolWrapper[] {
  if (!tools) return []

  return tools.flatMap(tool => {
    let description = tool.description || `Tool: ${tool.name}`
    // Truncate too long descriptions
    if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
      description = description.substring(0, KIRO_MAX_TOOL_DESC_LEN) + '...'
    }
    const kiroTool: KiroToolWrapper = {
      toolSpecification: {
        name: shortenToolName(tool.name, toolNameRegistry),
        description,
        inputSchema: { json: tool.input_schema }
      }
    }
    const cachePoint = toKiroCachePoint(tool.cache_control)
    return cachePoint ? [kiroTool, { cachePoint }] : [kiroTool]
  })
}

// ============ Kiro -> Claude Convert ============

export function kiroToClaudeResponse(
  content: string,
  toolUses: KiroToolUse[],
  usage: KiroUsage,
  model: string,
  toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
  reasoningContent?: { text?: string; signature?: string; redactedContent?: string }
): ClaudeResponse {
  const contentBlocks: ClaudeContentBlock[] = []
  const restoredToolUses = toolNameRegistry.restoreToolUses(toolUses)

  if (reasoningContent?.text) {
    contentBlocks.push(reasoningContent.signature ? {
      type: 'thinking',
      thinking: reasoningContent.text,
      signature: reasoningContent.signature
    } : {
      type: 'thinking',
      thinking: reasoningContent.text
    })
  }
  if (reasoningContent?.redactedContent) {
    contentBlocks.push({
      type: 'redacted_thinking',
      data: reasoningContent.redactedContent
    })
  }

  // Only added if there is actual text content text block
  if (content && content.trim()) {
    contentBlocks.push({ type: 'text', text: content })
  }

  for (const tu of restoredToolUses) {
    contentBlocks.push({
      type: 'tool_use',
      id: tu.toolUseId,
      name: tu.name,
      input: tu.input
    })
  }

  const claudeUsage: ClaudeResponse['usage'] = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens
  }
  if (usage.cacheWriteTokens) {
    claudeUsage.cache_creation_input_tokens = usage.cacheWriteTokens
  }
  if (usage.cacheReadTokens) {
    claudeUsage.cache_read_input_tokens = usage.cacheReadTokens
  }

  const response: ClaudeResponse = {
    id: `msg_${uuidv4()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model,
    stop_reason: restoredToolUses.length > 0 ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: claudeUsage
  }
  return response
}

export function createClaudeStreamEvent(
  type: ClaudeStreamEvent['type'],
  data?: Partial<ClaudeStreamEvent>
): ClaudeStreamEvent {
  return { type, ...data } as ClaudeStreamEvent
}
