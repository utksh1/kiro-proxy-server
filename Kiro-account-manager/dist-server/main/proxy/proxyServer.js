"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyServer = void 0;
// Kiro Proxy HTTP/HTTPS Server
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
const uuid_1 = require("uuid");
const accountPool_1 = require("./accountPool");
const kiroApi_1 = require("./kiroApi");
const logger_1 = require("./logger");
const kproxy_1 = require("../kproxy");
const translator_1 = require("./translator");
const toolNameRegistry_1 = require("./toolNameRegistry");
const promptCacheTracker_1 = require("./promptCacheTracker");
const steeringLoader_1 = require("./steeringLoader");
function modelDisplayName(id, modelName) {
    if (modelName?.trim())
        return modelName;
    return id
        .split('-')
        .filter(Boolean)
        .map(part => part === 'gpt' ? 'GPT' : part === 'ai' ? 'AI' : part[0]?.toUpperCase() + part.slice(1))
        .join(' ');
}
function modelFamily(id) {
    const lower = id.toLowerCase();
    if (lower.includes('opus'))
        return 'claude-opus';
    if (lower.includes('sonnet'))
        return 'claude-sonnet';
    if (lower.includes('haiku'))
        return 'claude-haiku';
    if (lower.includes('gpt-4o'))
        return 'gpt-4o';
    if (lower.includes('gpt-4'))
        return 'gpt-4';
    if (lower.includes('gpt-3.5'))
        return 'gpt-3.5';
    if (lower.includes('glm'))
        return 'glm';
    if (lower === 'auto')
        return 'auto';
    return lower.split(/[.-]/).slice(0, 2).join('-') || lower;
}
function modelOutputLimit(id, output) {
    if (typeof output === 'number' && output > 0)
        return output;
    const lower = id.toLowerCase();
    if (lower.includes('haiku') || lower.includes('gpt-3.5'))
        return 8192;
    return 32000;
}
function modelInputModalities(inputTypes) {
    const values = new Set(['text']);
    for (const item of inputTypes ?? []) {
        const lower = item.toLowerCase();
        if (lower.includes('image'))
            values.add('image');
        if (lower.includes('pdf') || lower.includes('document') || lower.includes('file'))
            values.add('pdf');
        if (lower.includes('audio'))
            values.add('audio');
        if (lower.includes('video'))
            values.add('video');
    }
    return Array.from(values);
}
function modelCapabilityMap(modalities) {
    return {
        text: modalities.includes('text'),
        audio: modalities.includes('audio'),
        image: modalities.includes('image'),
        video: modalities.includes('video'),
        pdf: modalities.includes('pdf')
    };
}
function extractThinkingSchema(schema) {
    if (!schema)
        return undefined;
    const props = schema.properties;
    if (!props)
        return undefined;
    // output_config path(Claude 4.6+ new model)
    if (props.output_config) {
        const effortField = props.output_config?.properties;
        const effortEnum = effortField?.effort?.enum;
        if (effortEnum && effortEnum.length > 0) {
            return { efforts: effortEnum, schemaPath: 'output_config' };
        }
    }
    // reasoning path (alternative)
    if (props.reasoning) {
        const reasoningProps = props.reasoning?.properties;
        const effortEnum = reasoningProps?.effort?.enum;
        if (effortEnum && effortEnum.length > 0) {
            return { efforts: effortEnum, schemaPath: 'reasoning' };
        }
    }
    // fallback for models with thinking or output_config without effort enum
    if (props.thinking || props.output_config) {
        return { efforts: ['low', 'medium', 'high', 'xhigh'], schemaPath: 'default' };
    }
    return undefined;
}
function buildClientModel(input) {
    const name = modelDisplayName(input.id, input.modelName);
    const inputModalities = modelInputModalities(input.supportedInputTypes);
    const outputModalities = ['text'];
    const output = modelOutputLimit(input.id, input.maxOutputTokens);
    const context = typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? input.maxInputTokens : 200000;
    let extractedThinking = extractThinkingSchema(input.additionalModelRequestFieldsSchema);
    const hasThinking = !!extractedThinking;
    const reasoning = hasThinking;
    const interleaved = hasThinking ? { field: 'reasoning_content' } : false;
    return {
        id: input.id,
        object: 'model',
        created: input.created,
        owned_by: input.ownedBy,
        name,
        description: input.description || name,
        model_name: input.modelName || name,
        family: modelFamily(input.id),
        release_date: '',
        attachment: inputModalities.some(item => item !== 'text'),
        reasoning,
        temperature: true,
        tool_call: true,
        interleaved,
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        limit: {
            context,
            ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { input: input.maxInputTokens } : {}),
            output
        },
        modalities: { input: inputModalities, output: outputModalities },
        capabilities: {
            temperature: true,
            reasoning,
            attachment: inputModalities.some(item => item !== 'text'),
            toolcall: true,
            input: modelCapabilityMap(inputModalities),
            output: modelCapabilityMap(outputModalities),
            interleaved
        },
        context_length: context,
        max_tokens: output,
        ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { max_input_tokens: input.maxInputTokens } : {}),
        max_output_tokens: output,
        inputTypes: input.supportedInputTypes,
        rateMultiplier: input.rateMultiplier,
        rateUnit: input.rateUnit,
        supportsThinking: !!extractedThinking,
        thinkingEfforts: extractedThinking?.efforts,
        thinkingSchemaPath: extractedThinking?.schemaPath,
        supportsPromptCaching: input.promptCaching?.supportsPromptCaching || false,
        modelProvider: input.modelProvider || undefined,
        permission: [],
        root: input.id,
        parent: null
    };
}
// Request body over-limit error (used for unified identification, triggered 413 response)
class BodyTooLargeError extends Error {
    received;
    limit;
    constructor(received, limit) {
        super(`Request body too large: ${received} bytes exceeds limit of ${limit} bytes`);
        this.received = received;
        this.limit = limit;
        this.name = 'BodyTooLargeError';
    }
}
class ProxyServer {
    server = null;
    fallbackServer = null; // HTTPS Listen simultaneously when enabled HTTP(optional)
    accountPool;
    config;
    stats;
    sessionStats;
    events;
    refreshingTokens = new Map(); // Refresh in transit to remove duplicates (concurrent parties share the same result)
    isHttps = false;
    isStopping = false;
    activeRequests = new Set();
    sockets = new Set();
    /** P1-7 according to API Key/IP Sliding window current limit (buckets per minute) */
    rateLimitBuckets = new Map();
    /** P1-8 Session stickiness:session hint → accountId The mapping of (10 minute TTL） */
    sessionAffinity = new Map();
    /** P2-17 Audit log (most recent 200 strip) */
    auditLog = [];
    /** Webhook Trigger callback (injected from outside, avoid main → renderer circular dependencies) */
    webhookTrigger;
    /** Clean regularly timer */
    cleanupTimer = null;
    /**
     * Extract from request session hint, used to stabilize conversationId
     * priority 1: Explicitly stable ID（header）
     * priority 2: Session-related fields in the request body (body）
     * priority 3:return undefined(Depend on kiroApi use history fingerprint reveal all the details)
     */
    static extractSessionHint(req, body) {
        const b = (body && typeof body === 'object' ? body : {});
        const h = req.headers;
        // priority 1: Explicitly stable header
        const headerHint = h['x-claude-code-session-id'] ||
            h['x-opencode-session'] ||
            h['x-session-affinity'] ||
            h['x-conversation-id'];
        if (headerHint)
            return headerHint;
        // priority 2：body Reliable session fields in
        const bodyHint = b.prompt_cache_key ||
            b.promptCacheKey ||
            b.conversation_id ||
            b.conversationId ||
            b.thread_id ||
            b.threadId ||
            b.session_id ||
            b.sessionId;
        if (bodyHint)
            return bodyHint;
        // priority 2.5：metadata in session/conversation
        const metadata = b.metadata;
        if (metadata) {
            const metaHint = metadata.session_id ||
                metadata.conversation_id;
            if (metaHint)
                return metaHint;
        }
        // priority 3: no explicit ID,return undefined（kiroApi use history fingerprint reveal all the details)
        return undefined;
    }
    constructor(config = {}, events = {}) {
        this.config = {
            enabled: false,
            port: 5580,
            host: '127.0.0.1',
            enableMultiAccount: true,
            selectedAccountIds: [],
            logRequests: true,
            maxConcurrent: 10,
            maxRetries: 3,
            retryDelayMs: 1000,
            tokenRefreshBeforeExpiry: 300, // 5Refresh minutes in advance
            autoStart: false, // Whether to start automatically
            clientDrivenToolExecution: true,
            ...config
        };
        this.accountPool = new accountPool_1.AccountPool();
        this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin');
        this.stats = {
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            totalTokens: 0,
            totalCredits: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            startTime: Date.now(),
            accountStats: new Map(),
            endpointStats: new Map(),
            modelStats: new Map(),
            recentRequests: []
        };
        this.sessionStats = {
            totalRequests: 0,
            successRequests: 0,
            failedRequests: 0,
            startTime: 0
        };
        this.events = events;
    }
    /**
     * Detect whether the current binding address will be exposed outside the local machine
     * 0.0.0.0 / :: / Network card address → true；127.0.0.1 / ::1 / localhost → false
     */
    isBindingExternal(host) {
        if (!host)
            return false;
        const h = host.toLowerCase().trim();
        return h === '0.0.0.0' || h === '::' || h === '*' || (h !== '127.0.0.1' && h !== '::1' && h !== 'localhost');
    }
    // Start the server
    async start() {
        if (this.server) {
            console.log('[ProxyServer] Server already running');
            return;
        }
        // P0-2 Security guardrail: External network binding + none API Key → Deny startup (the user can explicitly allowExternalWithoutApiKey Lift)
        if (this.isBindingExternal(this.config.host)) {
            const hasAnyKey = (this.config.apiKeys?.some(k => k.enabled && k.key) ?? false) || !!this.config.apiKey;
            if (!hasAnyKey && !this.config.allowExternalWithoutApiKey) {
                const err = new Error(`[Security] Refused to start: host=${this.config.host} exposes to network but no API Key configured. ` +
                    `Set at least one API Key, or change host to 127.0.0.1, or set allowExternalWithoutApiKey=true (NOT RECOMMENDED).`);
                console.error('[ProxyServer]', err.message);
                this.events.onError?.(err);
                throw err;
            }
            if (!hasAnyKey) {
                console.warn(`[ProxyServer] [Security] WARNING: binding to ${this.config.host} without API Key (allowExternalWithoutApiKey=true). This exposes your accounts to the network!`);
            }
        }
        return new Promise((resolve, reject) => {
            this.isStopping = false;
            const requestHandler = (req, res) => this.handleRequest(req, res);
            // Check if enabled TLS
            if (this.config.tls?.enabled) {
                try {
                    const tlsOptions = this.getTlsOptions();
                    this.server = https_1.default.createServer(tlsOptions, requestHandler);
                    this.isHttps = true;
                }
                catch (error) {
                    reject(new Error(`TLS configuration error: ${error.message}`));
                    return;
                }
            }
            else {
                this.server = http_1.default.createServer(requestHandler);
                this.isHttps = false;
            }
            this.server.on('error', (error) => {
                if (error.code === 'EADDRINUSE') {
                    console.error(`[ProxyServer] Port ${this.config.port} is already in use`);
                    reject(new Error(`Port ${this.config.port} is already in use`));
                }
                else {
                    console.error('[ProxyServer] Server error:', error);
                    reject(error);
                }
                this.events.onError?.(error);
            });
            this.server.on('connection', (socket) => {
                this.sockets.add(socket);
                socket.on('close', () => this.sockets.delete(socket));
                // P1-10 backpressure monitor:socket Write buffer exceeded 1MB Log warning when
                socket.on('drain', () => {
                    if (socket.writableLength > 0) {
                        logger_1.proxyLogger.debug('ProxyServer', `Socket drain: bufferedLen=${socket.writableLength}`);
                    }
                });
            });
            // Attempt to automatically restart when server is shut down
            this.server.on('close', () => {
                if (!this.isStopping && this.config.autoStart && this.config.enabled) {
                    console.log('[ProxyServer] Server closed unexpectedly, attempting restart in 3s...');
                    setTimeout(() => {
                        if (!this.isStopping && this.config.autoStart && !this.isRunning()) {
                            console.log('[ProxyServer] Auto-restarting...');
                            this.start().catch(err => {
                                console.error('[ProxyServer] Auto-restart failed:', err);
                            });
                        }
                    }, 3000);
                }
            });
            // P1-11 keep-alive / headers Idle timeout (to avoid long connections occupying resources)
            // Increased default timeout to 5 minutes for long streaming responses (e.g., Codex)
            const keepAliveMs = this.config.keepAliveTimeoutMs ?? 300_000; // 5 minutes instead of 65 seconds
            const headersMs = this.config.headersTimeoutMs ?? 295_000; // Slightly less than keepAlive
            this.server.keepAliveTimeout = keepAliveMs;
            this.server.headersTimeout = Math.max(headersMs, keepAliveMs + 1000); // headers must > keepAlive,otherwise Node meeting warn
            this.server.requestTimeout = 0; // Streaming responses may be long, disabled request total timeout
            // Start regular cleanup (every 5 minute)
            if (this.cleanupTimer)
                clearInterval(this.cleanupTimer);
            this.cleanupTimer = setInterval(() => this.cleanupExpiredCaches(), 5 * 60_000);
            // let timer exist Node No blocking on exit
            this.cleanupTimer.unref?.();
            const protocol = this.isHttps ? 'https' : 'http';
            this.server.listen(this.config.port, this.config.host, () => {
                logger_1.proxyLogger.info('ProxyServer', `Started on ${protocol}://${this.config.host}:${this.config.port} (keepAlive=${keepAliveMs}ms)`);
                this.stats.startTime = Date.now();
                // Reset session statistics
                this.sessionStats = {
                    totalRequests: 0,
                    successRequests: 0,
                    failedRequests: 0,
                    startTime: Date.now()
                };
                this.events.onStatusChange?.(true, this.config.port);
                resolve();
            });
            // D4 enable TLS Monitor at the same time HTTP fallback port (if configured fallbackPort）
            if (this.isHttps && this.config.fallbackPort && this.config.fallbackPort !== this.config.port) {
                const fallback = http_1.default.createServer(requestHandler);
                fallback.keepAliveTimeout = keepAliveMs;
                fallback.headersTimeout = Math.max(headersMs, keepAliveMs + 1000);
                fallback.requestTimeout = 0;
                fallback.on('connection', (socket) => {
                    this.sockets.add(socket);
                    socket.on('close', () => this.sockets.delete(socket));
                });
                fallback.on('error', (err) => logger_1.proxyLogger.warn('ProxyServer', `Fallback HTTP error: ${err.message}`));
                fallback.listen(this.config.fallbackPort, this.config.host, () => {
                    logger_1.proxyLogger.info('ProxyServer', `Fallback HTTP listening on http://${this.config.host}:${this.config.fallbackPort}`);
                });
                this.fallbackServer = fallback;
            }
        });
    }
    // get TLS Configuration options
    // P1-13 when tls.enabled but not provided cert/key When, a self-signed certificate is automatically generated
    getTlsOptions() {
        const tls = this.config.tls;
        let cert;
        let key;
        // Priority is given to directly provided PEM content
        if (tls.cert && tls.key) {
            cert = tls.cert;
            key = tls.key;
        }
        else if (tls.certPath && tls.keyPath) {
            // read from file
            cert = fs_1.default.readFileSync(tls.certPath, 'utf8');
            key = fs_1.default.readFileSync(tls.keyPath, 'utf8');
        }
        else {
            // Automatically generate a self-signed certificate (located at userData/proxy-tls/）
            try {
                const { app } = require('electron');
                const { ensureProxySelfSignedCert } = require('./selfSignedCert');
                const hostnames = [this.config.host || '127.0.0.1'];
                const result = ensureProxySelfSignedCert(app.getPath('userData'), hostnames);
                logger_1.proxyLogger.info('ProxyServer', `Using self-signed TLS cert (SAN=${result.altNames.join(',')}, fingerprint=${result.fingerprint.slice(0, 19)}...)`);
                cert = result.cert;
                key = result.key;
            }
            catch (err) {
                throw new Error(`TLS enabled but no certificate/key provided and auto-generation failed: ${err.message}`);
            }
        }
        return { cert, key };
    }
    /**
     * Obtain (or generate) anti-generation self-signed certificate information (for UI show/Export PEM）
     */
    getSelfSignedCertInfo() {
        try {
            const { app } = require('electron');
            const { ensureProxySelfSignedCert } = require('./selfSignedCert');
            return ensureProxySelfSignedCert(app.getPath('userData'), [this.config.host || '127.0.0.1']);
        }
        catch (err) {
            logger_1.proxyLogger.warn('ProxyServer', `getSelfSignedCertInfo failed: ${err.message}`);
            return null;
        }
    }
    /** Force regeneration of self-signed certificates (users are UI On point"Regenerate"） */
    regenerateSelfSignedCert() {
        try {
            const { app } = require('electron');
            const { ensureProxySelfSignedCert } = require('./selfSignedCert');
            this.appendAuditLog('regenerate_self_signed_cert', { host: this.config.host });
            return ensureProxySelfSignedCert(app.getPath('userData'), [this.config.host || '127.0.0.1'], true);
        }
        catch (err) {
            logger_1.proxyLogger.warn('ProxyServer', `regenerateSelfSignedCert failed: ${err.message}`);
            return null;
        }
    }
    /**
     * Stop the server gracefully
     * - Immediately reject new connections (server.close）
     * - For requests in progress 5 Completed in seconds; forced after timeout destroy socket
     * - Stop at the same time fallback HTTP server
     */
    async stop(gracefulMs = 5000) {
        if (!this.server) {
            return;
        }
        this.isStopping = true;
        const main = this.server;
        const fallback = this.fallbackServer;
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                logger_1.proxyLogger.info('ProxyServer', 'Stopped');
                this.server = null;
                this.fallbackServer = null;
                this.isStopping = false;
                this.activeRequests.clear();
                this.sockets.clear();
                if (this.cleanupTimer) {
                    clearInterval(this.cleanupTimer);
                    this.cleanupTimer = null;
                }
                this.events.onStatusChange?.(false, this.config.port);
                resolve();
            };
            // Stop accepting new connections first
            main.close(() => {
                fallback?.close(() => finish()) || finish();
            });
            fallback?.close();
            // P1-14 Graceful stop: Give the ongoing request time to complete, and then force it after timeout
            this.activeRequests.forEach(controller => {
                // Give the client a clear stop Signal, but do not immediately interrupt the flow of sent responses
                try {
                    controller.abort(new Error('Proxy server stopped'));
                }
                catch { /* ignore */ }
            });
            // timeout enforcement destroy
            setTimeout(() => {
                this.sockets.forEach(socket => { try {
                    socket.destroy();
                }
                catch { /* ignore */ } });
                finish();
            }, Math.max(0, gracefulMs));
        });
    }
    // Update configuration
    // P2-18 detected port/host/tls When changing, mark needsRestart=true，UI Can read and prompt
    _needsRestart = false;
    updateConfig(config) {
        // Mark fields that need to be restarted
        const restartTriggerFields = ['port', 'host', 'tls', 'fallbackPort'];
        const willRestart = restartTriggerFields.some(k => k in config && JSON.stringify(this.config[k]) !== JSON.stringify(config[k]));
        if (willRestart && this.isRunning()) {
            this._needsRestart = true;
            logger_1.proxyLogger.warn('ProxyServer', `Config change requires restart: ${restartTriggerFields.filter(k => k in config).join(', ')}`);
        }
        this.appendAuditLog('config_changed', { fields: Object.keys(config), needsRestart: willRestart });
        this.config = { ...this.config, ...config };
        // Synchronize account selection strategy to accountPool
        if (config.accountSelectionStrategy !== undefined) {
            this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'round-robin');
        }
    }
    /** UI This can be used to determine whether the user needs to be prompted to restart. */
    needsRestart() {
        return this._needsRestart;
    }
    /** Call clear after reboot needsRestart mark */
    async restartServer() {
        if (!this.isRunning()) {
            await this.start();
            this._needsRestart = false;
            return;
        }
        await this.stop();
        await this.start();
        this._needsRestart = false;
    }
    // Get configuration
    getConfig() {
        return { ...this.config };
    }
    validateCacheControl(cacheControl) {
        if (!cacheControl)
            return;
        if (cacheControl.type !== 'ephemeral') {
            throw new Error(`Unsupported cache_control type: ${cacheControl.type}`);
        }
    }
    validateClaudeContentBlocks(blocks) {
        blocks.forEach(block => {
            this.validateCacheControl(block.cache_control);
            if (Array.isArray(block.content)) {
                this.validateClaudeContentBlocks(block.content);
            }
        });
    }
    validateOpenAICacheControls(request) {
        request.messages.forEach(message => {
            this.validateCacheControl(message.cache_control);
            if (Array.isArray(message.content)) {
                message.content.forEach(part => this.validateCacheControl(part.cache_control));
            }
        });
        request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control));
    }
    validateClaudeCacheControls(request) {
        if (Array.isArray(request.system)) {
            request.system.forEach(block => this.validateCacheControl(block.cache_control));
        }
        request.messages.forEach(message => {
            this.validateCacheControl(message.cache_control);
            if (Array.isArray(message.content)) {
                this.validateClaudeContentBlocks(message.content);
            }
        });
        request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control));
    }
    async downloadImageDataUrl(url, signal) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const abort = () => controller.abort(this.getAbortError(signal));
        try {
            if (signal?.aborted)
                throw this.getAbortError(signal);
            signal?.addEventListener('abort', abort, { once: true });
            const agent = (() => {
                const { getSystemProxy, safeCreateProxyAgent } = require('./systemProxy');
                const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
                const envAgent = safeCreateProxyAgent(envProxy);
                if (envAgent)
                    return envAgent;
                return safeCreateProxyAgent(getSystemProxy());
            })();
            const { fetch: undiciFetch } = require('undici');
            const response = agent
                ? await undiciFetch(url, { signal: controller.signal, dispatcher: agent })
                : await fetch(url, { signal: controller.signal });
            if (!response.ok) {
                throw new Error(`Failed to download image: HTTP ${response.status}`);
            }
            const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase();
            if (!contentType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
                throw new Error(`Unsupported image content-type: ${contentType || 'unknown'}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
                throw new Error('Image exceeds 10MB limit');
            }
            return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`;
        }
        finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abort);
        }
    }
    async resolveOpenAIHttpImages(request, signal) {
        await Promise.all(request.messages.map(async (message) => {
            if (!Array.isArray(message.content))
                return;
            await Promise.all(message.content.map(async (part) => {
                if (part.type !== 'image_url' || !part.image_url?.url.startsWith('http'))
                    return;
                part.image_url.url = await this.downloadImageDataUrl(part.image_url.url, signal);
            }));
        }));
        return request;
    }
    async resolveClaudeHttpImages(request, signal) {
        await Promise.all(request.messages.map(async (message) => {
            if (!Array.isArray(message.content))
                return;
            await Promise.all(message.content.map(async (block) => {
                if (block.type !== 'image' || block.source?.type !== 'url')
                    return;
                const dataUrl = await this.downloadImageDataUrl(block.source.url, signal);
                const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
                if (!match) {
                    throw new Error('Downloaded image produced invalid data URL');
                }
                block.source = { type: 'base64', media_type: match[1], data: match[2] };
            }));
        }));
        return request;
    }
    prepareOpenAIRequest(request) {
        this.validateOpenAICacheControls(request);
        if (this.config.disableTools || request.tool_choice === 'none') {
            return { ...request, tools: undefined, tool_choice: undefined };
        }
        if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.type === 'function' && !request.tool_choice.function?.name) {
            throw new Error('tool_choice function requires a tool name');
        }
        if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.function?.name) {
            const selectedToolName = request.tool_choice.function.name;
            if (!request.tools?.some(tool => tool.function.name === selectedToolName)) {
                throw new Error(`tool_choice references unknown tool: ${selectedToolName}`);
            }
            return {
                ...request,
                tools: request.tools?.filter(tool => tool.function.name === selectedToolName)
            };
        }
        return request;
    }
    prepareClaudeRequest(request) {
        this.validateClaudeCacheControls(request);
        if (this.config.disableTools || request.tool_choice?.type === 'none') {
            return { ...request, tools: undefined, tool_choice: undefined };
        }
        if (request.tool_choice?.type === 'tool' && !request.tool_choice.name) {
            throw new Error('tool_choice tool requires a tool name');
        }
        if (request.tool_choice?.name) {
            const selectedToolName = request.tool_choice.name;
            if (!request.tools?.some(tool => tool.name === selectedToolName)) {
                throw new Error(`tool_choice references unknown tool: ${selectedToolName}`);
            }
            return {
                ...request,
                tools: request.tools?.filter(tool => tool.name === selectedToolName)
            };
        }
        return request;
    }
    // Get statistics
    getStats() {
        // Returns serializable statistics (Map The object is in IPC cannot be serialized correctly)
        return {
            totalRequests: this.stats.totalRequests,
            successRequests: this.stats.successRequests,
            failedRequests: this.stats.failedRequests,
            totalTokens: this.stats.totalTokens,
            totalCredits: this.stats.totalCredits,
            inputTokens: this.stats.inputTokens,
            outputTokens: this.stats.outputTokens,
            cacheReadTokens: this.stats.cacheReadTokens,
            cacheWriteTokens: this.stats.cacheWriteTokens,
            reasoningTokens: this.stats.reasoningTokens,
            startTime: this.stats.startTime,
            accountStats: this.stats.accountStats,
            endpointStats: this.stats.endpointStats,
            modelStats: this.stats.modelStats,
            recentRequests: this.stats.recentRequests
        };
    }
    // Get account pool
    getAccountPool() {
        return this.accountPool;
    }
    // Set initial accumulation credits(for restoring from persistent storage)
    setTotalCredits(credits) {
        this.stats.totalCredits = credits;
    }
    // reset total credits
    resetTotalCredits() {
        this.stats.totalCredits = 0;
        this.events.onCreditsUpdate?.(0);
    }
    // Set initial accumulation tokens(for restoring from persistent storage)
    setTotalTokens(inputTokens, outputTokens) {
        this.stats.inputTokens = inputTokens;
        this.stats.outputTokens = outputTokens;
        this.stats.totalTokens = inputTokens + outputTokens;
    }
    // reset total tokens
    resetTotalTokens() {
        this.stats.inputTokens = 0;
        this.stats.outputTokens = 0;
        this.stats.totalTokens = 0;
    }
    // Set request statistics (for recovery from persistent storage)
    setRequestStats(totalRequests, successRequests, failedRequests) {
        this.stats.totalRequests = totalRequests;
        this.stats.successRequests = successRequests;
        this.stats.failedRequests = failedRequests;
    }
    // Reset request statistics
    resetRequestStats() {
        this.stats.totalRequests = 0;
        this.stats.successRequests = 0;
        this.stats.failedRequests = 0;
        this.notifyRequestStatsUpdate();
    }
    // Notification request statistics update
    notifyRequestStatsUpdate() {
        this.events.onRequestStatsUpdate?.(this.stats.totalRequests, this.stats.successRequests, this.stats.failedRequests);
    }
    // Record request successful
    recordRequestSuccess() {
        this.stats.successRequests++;
        this.sessionStats.successRequests++;
        this.notifyRequestStatsUpdate();
    }
    // Logging request failed
    recordRequestFailed() {
        this.stats.failedRequests++;
        this.sessionStats.failedRequests++;
        this.notifyRequestStatsUpdate();
    }
    // Log new requests
    recordNewRequest() {
        this.stats.totalRequests++;
        this.sessionStats.totalRequests++;
        this.notifyRequestStatsUpdate();
    }
    // Get session statistics (statistics during the current service run)
    getSessionStats() {
        return { ...this.sessionStats };
    }
    // Is it running?
    isRunning() {
        return this.server !== null;
    }
    getAbortError(signal) {
        if (signal?.reason instanceof Error)
            return signal.reason;
        if (signal?.reason)
            return new Error(String(signal.reason));
        return new Error('Request aborted');
    }
    isAbortError(error, signal) {
        return signal?.aborted === true
            || (error instanceof Error && (error.message.includes('Client disconnected') || error.message.includes('Proxy server stopped')));
    }
    throwIfAborted(signal) {
        if (signal?.aborted)
            throw this.getAbortError(signal);
    }
    throwIfResponseClosed(res, signal) {
        this.throwIfAborted(signal);
        if (res.writableEnded || res.destroyed)
            throw new Error('Client disconnected');
    }
    isResponseClosed(res) {
        return res.writableEnded || res.destroyed;
    }
    /**
     * SSE Back pressure:res.write The buffer is full (writableNeedDrain) returns to wait drain of promise，
     * Upstream flow analysis await It pauses pulls to prevent slow clients from causing infinite memory accumulation.
     * Monitor simultaneously close/error, immediately release the client when it disconnects (to prevent promise hangs permanently).
     * Return when buffer is not full undefined(zero-overhead fast path).
     */
    waitForDrain(res) {
        if (!res.writableNeedDrain || res.destroyed || res.writableEnded)
            return undefined;
        return new Promise((resolve) => {
            const done = () => {
                res.off('drain', done);
                res.off('close', done);
                res.off('error', done);
                resolve();
            };
            res.once('drain', done);
            res.once('close', done);
            res.once('error', done);
        });
    }
    // Detect whether the error message contains characteristics indicating that the account has been banned for a long time
    // return { reason, message } Indicates the need for marking suspended;return null Indicates non-ban error
    // cover:
    //   - Kiro rear end HTTP 403 + body: { reason: "TEMPORARILY_SUSPENDED", message: "..." }
    //   - CodeWhisperer AccountSuspendedException
    //   - 423 Locked
    detectSuspendedError(errMsg) {
        if (!errMsg)
            return null;
        // 1) explicit reason: "TEMPORARILY_SUSPENDED" (Kiro Risk control)
        const reasonMatch = errMsg.match(/"reason"\s*:\s*"(TEMPORARILY_SUSPENDED|ACCOUNT_SUSPENDED|PERMANENTLY_SUSPENDED)"/i);
        if (reasonMatch) {
            // Try to extract message Field
            const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/);
            return { reason: reasonMatch[1].toUpperCase(), message: msgMatch?.[1] || errMsg };
        }
        // 2) text features "temporarily suspended" / "user id is ... suspended"
        if (/User\s+ID\s+is\s+(temporarily\s+)?suspended/i.test(errMsg) || /temporarily\s+suspended/i.test(errMsg)) {
            const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/);
            return { reason: 'TEMPORARILY_SUSPENDED', message: msgMatch?.[1] || errMsg };
        }
        // 3) AccountSuspendedException (CodeWhisperer)
        if (errMsg.includes('AccountSuspendedException') || errMsg.includes('Account suspended')) {
            const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/);
            return { reason: 'AccountSuspendedException', message: msgMatch?.[1] || errMsg };
        }
        // 4) HTTP 423 Locked
        if (/\b423\b/.test(errMsg) && /locked|suspended/i.test(errMsg)) {
            return { reason: 'ACCOUNT_LOCKED', message: errMsg };
        }
        return null;
    }
    waitForRetry(ms, signal) {
        this.throwIfAborted(signal);
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                signal?.removeEventListener('abort', abort);
                resolve();
            }, ms);
            const abort = () => {
                clearTimeout(timeout);
                reject(this.getAbortError(signal));
            };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async abortable(promise, signal) {
        this.throwIfAborted(signal);
        if (!signal)
            return promise;
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                const abort = () => reject(this.getAbortError(signal));
                signal.addEventListener('abort', abort, { once: true });
                promise.then(() => signal.removeEventListener('abort', abort), () => signal.removeEventListener('abort', abort));
            })
        ]);
    }
    // Clear the model cache and force re-fetching on the next request
    clearModelCache() {
        this.modelCache = null;
        console.log('[ProxyServer] Model cache cleared');
    }
    // Find the specified model from the model cache thinking Configuration
    getThinkingConfig(modelId) {
        // Debug to file
        try {
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `\n[${new Date().toISOString()}] getThinkingConfig CALLED for model: ${modelId}\n`);
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  modelCache exists: ${!!this.modelCache}\n`);
        }
        catch (e) { }
        const logMsg = `[getThinkingConfig] model=${modelId}, cacheExists=${!!this.modelCache}`;
        console.log(logMsg);
        logger_1.proxyLogger.info('ThinkingConfig', logMsg);
        if (!this.modelCache) {
            const errMsg = `modelCache is null for model ${modelId}`;
            console.log(`[ERROR] ${errMsg}`);
            logger_1.proxyLogger.error('ThinkingConfig', errMsg);
            try {
                require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RESULT: undefined (modelCache is null)\n`);
            }
            catch (e) { }
            return undefined;
        }
        try {
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  modelCache has ${this.modelCache.models.length} models\n`);
        }
        catch (e) { }
        logger_1.proxyLogger.info('ThinkingConfig', `modelCache has ${this.modelCache.models.length} models`);
        // Dump all model IDs and their schema status
        try {
            for (const m of this.modelCache.models) {
                const hasS = !!m.additionalModelRequestFieldsSchema;
                const sPath = hasS ? extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.schemaPath : 'N/A';
                require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `    - ${m.modelId}: hasSchema=${hasS}, schemaPath=${sPath}\n`);
            }
        }
        catch (e) { }
        const lower = modelId.toLowerCase();
        const model = this.modelCache.models.find(m => m.modelId.toLowerCase() === lower);
        if (!model) {
            const errMsg = `model ${modelId} not found in cache`;
            console.log(`[ERROR] ${errMsg}`);
            logger_1.proxyLogger.error('ThinkingConfig', errMsg);
            try {
                require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RESULT: undefined (model not found in cache)\n`);
            }
            catch (e) { }
            return undefined;
        }
        try {
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  Found model, hasSchema: ${!!model.additionalModelRequestFieldsSchema}\n`);
        }
        catch (e) { }
        logger_1.proxyLogger.info('ThinkingConfig', `Found model ${modelId}, hasSchema=${!!model.additionalModelRequestFieldsSchema}`);
        // Dump full raw model data for debugging
        try {
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RAW model keys: ${Object.keys(model).join(', ')}\n`);
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RAW additionalModelRequestFieldsSchema: ${JSON.stringify(model.additionalModelRequestFieldsSchema, null, 2)}\n`);
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RAW modelId: ${model.modelId}\n`);
        }
        catch (e) { }
        let schema = extractThinkingSchema(model.additionalModelRequestFieldsSchema);
        // Fallback: Kiro backend currently returns null schema for ALL models,
        // but thinking is fully supported server-side (reasoningContentEvent works).
        // Inject thinking config for Claude models that are known to support it.
        if (!schema) {
            const lower = modelId.toLowerCase();
            if (lower.includes('claude-sonnet-4.5') || lower.includes('claude-4-5-sonnet') ||
                lower.includes('claude-sonnet-4') || lower.includes('claude-4-sonnet') ||
                lower.includes('claude-3-7-sonnet') || lower.includes('claude-sonnet-3.7') ||
                lower.includes('claude-haiku-4') || lower.includes('claude-4-haiku') ||
                lower.includes('claude-opus') || lower.includes('claude-4-opus')) {
                schema = { schemaPath: 'output_config', efforts: ['low', 'medium', 'high', 'xhigh'] };
                logger_1.proxyLogger.info('ThinkingConfig', `Applied thinking fallback for Claude model ${modelId} (output_config path)`);
                try {
                    require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  FALLBACK: Applied output_config thinking for Claude model ${modelId}\n`);
                }
                catch (e) { }
            }
        }
        if (!schema?.schemaPath || !schema.efforts?.length) {
            const infoMsg = `model ${modelId} has no valid thinking schema`;
            console.log(`[INFO] ${infoMsg}`);
            logger_1.proxyLogger.info('ThinkingConfig', infoMsg);
            try {
                require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RESULT: undefined (no valid schema - schemaPath: ${schema?.schemaPath}, efforts: ${schema?.efforts})\n`);
            }
            catch (e) { }
            return undefined;
        }
        const successMsg = `model ${modelId} supports thinking: schema=${schema.schemaPath}, efforts=${schema.efforts.join(',')}`;
        console.log(`[SUCCESS] ${successMsg}`);
        logger_1.proxyLogger.info('ThinkingConfig', successMsg);
        try {
            require('fs').appendFileSync('/tmp/kiro-thinking-debug.log', `  RESULT: ThinkingConfig { schemaPath: ${schema.schemaPath}, efforts: [${schema.efforts.join(',')}], defaultEffort: 'high' }\n`);
        }
        catch (e) { }
        return { schemaPath: schema.schemaPath, efforts: schema.efforts, defaultEffort: 'high' };
    }
    // Get a list of available models
    static mapKiroModelToApi(m) {
        return {
            id: m.modelId,
            name: m.modelName,
            description: m.description,
            inputTypes: m.supportedInputTypes,
            maxInputTokens: m.tokenLimits?.maxInputTokens,
            maxOutputTokens: m.tokenLimits?.maxOutputTokens,
            rateMultiplier: m.rateMultiplier,
            rateUnit: m.rateUnit,
            supportsThinking: !!m.additionalModelRequestFieldsSchema?.properties?.thinking || !!m.additionalModelRequestFieldsSchema?.properties?.output_config,
            thinkingEfforts: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.efforts,
            thinkingSchemaPath: extractThinkingSchema(m.additionalModelRequestFieldsSchema)?.schemaPath,
            supportsPromptCaching: m.promptCaching?.supportsPromptCaching || false,
            modelProvider: m.modelProvider || undefined
        };
    }
    async getAvailableModels(signal) {
        const now = Date.now();
        let kiroModels;
        let fromCache = false;
        if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
            kiroModels = this.modelCache.models;
            fromCache = true;
        }
        else {
            this.throwIfAborted(signal);
            const account = await this.getAvailableAccount(signal);
            this.throwIfAborted(signal);
            if (!account) {
                return { models: [], fromCache: false };
            }
            try {
                kiroModels = await (0, kiroApi_1.fetchKiroModels)(account, signal);
                if (kiroModels.length > 0) {
                    this.modelCache = { models: kiroModels, timestamp: now };
                    // Sync to kiroApi of ctx cache, for token Clipping logic usage
                    for (const m of kiroModels) {
                        if (m.tokenLimits?.maxInputTokens) {
                            (0, kiroApi_1.setModelContextWindow)(m.modelId, m.tokenLimits.maxInputTokens);
                        }
                    }
                }
            }
            catch (error) {
                if (this.isAbortError(error, signal))
                    throw error;
                console.error('[ProxyServer] Failed to fetch models:', error);
                return { models: [], fromCache: false };
            }
        }
        // Merge hidden models (with /v1/models endpoints are consistent)
        const modelIds = new Set(kiroModels.map(m => m.modelId));
        const hiddenModels = [
            { modelId: 'claude-3.7-sonnet', modelName: 'Claude 3.7 Sonnet', description: 'Claude 3.7 Sonnet (hidden)', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } },
            { modelId: 'simple-task', modelName: 'Simple Task', description: 'Kiro fast model (routes to Haiku)', supportedInputTypes: ['TEXT'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 4096 } },
            { modelId: 'CLAUDE_SONNET_4_20250514_V1_0', modelName: 'Claude Sonnet 4 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } },
            { modelId: 'CLAUDE_HAIKU_4_5_20251001_V1_0', modelName: 'Claude Haiku 4.5 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } },
            { modelId: 'CLAUDE_3_7_SONNET_20250219_V1_0', modelName: 'Claude 3.7 Sonnet (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } }
        ];
        const merged = [...kiroModels, ...hiddenModels.filter(m => !modelIds.has(m.modelId))];
        return { models: merged.map(ProxyServer.mapKiroModelToApi), fromCache };
    }
    // examine Token Do you need to refresh
    isTokenExpiringSoon(account) {
        if (!account.expiresAt)
            return false;
        const refreshBeforeMs = (this.config.tokenRefreshBeforeExpiry || 300) * 1000;
        return Date.now() + refreshBeforeMs >= account.expiresAt;
    }
    // refresh Token
    async refreshToken(account, signal) {
        this.throwIfAborted(signal);
        if (!this.events.onTokenRefresh) {
            console.warn('[ProxyServer] No token refresh callback configured');
            return false;
        }
        // Concurrent deduplication: wait for in-flight refresh and reuse its real results.
        // Old implementation fixed etc. 1 Press expiration time after seconds"Guess"As a result, slow refresh (network jitter/Slow proxy) will be misjudged as failed, resulting in redundant number switching.
        const existing = this.refreshingTokens.get(account.id);
        if (existing) {
            console.log(`[ProxyServer] Token refresh already in progress for ${account.email || account.id}, awaiting result`);
            try {
                return await this.abortable(existing, signal);
            }
            catch {
                // only"Ben asks himself"It is thrown upward only when it is interrupted; the refresh in progress is interrupted by the initiator./When it fails, the request will be treated as refresh failure.
                if (signal?.aborted)
                    throw this.getAbortError(signal);
                return false;
            }
        }
        const task = this.doRefreshToken(account, signal);
        this.refreshingTokens.set(account.id, task);
        try {
            return await task;
        }
        finally {
            this.refreshingTokens.delete(account.id);
        }
    }
    /** actual execution Token Refresh (by refreshToken Called after the package is deduplicated in transit) */
    async doRefreshToken(account, signal) {
        console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`);
        try {
            // random delay 0-3 seconds to prevent simultaneous refresh of multiple accounts from being recognized as a batch operation.
            const jitter = Math.floor(Math.random() * 3000);
            if (jitter > 0)
                await this.waitForRetry(jitter, signal);
            const result = await this.abortable(this.events.onTokenRefresh(account), signal);
            if (result.success && result.accessToken) {
                // Update the account pool Token
                this.accountPool.updateAccount(account.id, {
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken || account.refreshToken,
                    expiresAt: result.expiresAt
                });
                // Notify external updates
                this.events.onAccountUpdate?.({
                    ...account,
                    accessToken: result.accessToken,
                    refreshToken: result.refreshToken || account.refreshToken,
                    expiresAt: result.expiresAt
                });
                console.log(`[ProxyServer] Token refreshed for ${account.email || account.id}`);
                return true;
            }
            else {
                console.error(`[ProxyServer] Token refresh failed for ${account.email || account.id}: ${result.error}`);
                this.accountPool.markNeedsRefresh(account.id);
                return false;
            }
        }
        catch (error) {
            if (this.isAbortError(error, signal))
                throw error;
            console.error(`[ProxyServer] Token refresh error for ${account.email || account.id}:`, error);
            this.accountPool.markNeedsRefresh(account.id);
            return false;
        }
    }
    /**
     * calculate API Key Allowed accounts ID gather(P2-21）
     * return undefined = Unlimited (all accounts allowed)
     */
    getAllowedAccountIds(apiKeyId) {
        if (!apiKeyId)
            return undefined;
        const bindings = this.config.apiKeyAccountBindings?.[apiKeyId];
        if (!bindings || bindings.length === 0)
            return undefined;
        return new Set(bindings);
    }
    // Get available accounts (including Token refresh check)
    // P1-8 sessionHint: Try to reuse the same account for the same session (hit prompt cache + Risk prevention and control)
    // P2-21 apiKeyId: used for filtering API Key A subset of accounts allowed to be used
    async getAvailableAccount(signal, sessionHint, apiKeyId) {
        const allowedIds = this.getAllowedAccountIds(apiKeyId);
        const groupMode = this.config.multiAccountSelectionMode === 'groups';
        const allowedGroupIds = groupMode ? new Set(this.config.multiAccountGroupIds || []) : null;
        const isAllowed = (acc) => {
            if (!acc)
                return true;
            // API Key whitelist (apiKeyAccountBindings）
            if (allowedIds && !allowedIds.has(acc.id))
                return false;
            // Group filtering (double insurance: even if the front end forgets to resynchronize the account pool, accounts in non-selected groups can be blocked here)
            if (groupMode && allowedGroupIds) {
                const gid = acc.groupId || '__ungrouped__';
                if (!allowedGroupIds.has(gid))
                    return false;
            }
            return true;
        };
        this.throwIfAborted(signal);
        // if pool If it is empty, trigger the lazy loading callback and try to synchronize the account (cold start scenario)
        if (this.accountPool.size === 0 && this.events.onPoolEmpty) {
            console.log('[ProxyServer] Account pool empty, triggering lazy sync...');
            await this.abortable(this.events.onPoolEmpty(), signal);
        }
        this.throwIfAborted(signal);
        // P1-8 Session stickiness: Give priority to reusing bound accounts (also subject to API Key binding filter)
        if (this.config.sessionAffinityEnabled && sessionHint) {
            const sticky = this.pickAccountWithAffinity(sessionHint);
            if (sticky && isAllowed(sticky)) {
                logger_1.proxyLogger.debug('ProxyServer', `Session affinity hit: ${sessionHint.slice(0, 16)} → ${sticky.email || sticky.id.slice(0, 8)}`);
                // Still need to check token Do you need to refresh
                if (this.isTokenExpiringSoon(sticky)) {
                    const refreshed = await this.refreshToken(sticky, signal);
                    if (refreshed) {
                        return this.accountPool.getAccount(sticky.id) || sticky;
                    }
                }
                else {
                    return sticky;
                }
            }
        }
        let account;
        if (this.config.enableMultiAccount) {
            account = this.accountPool.getNextAccount();
            if (account && !isAllowed(account)) {
                // Try to find an allowed account (whitelist + Groups have been merged into isAllowed）
                const allAccounts = this.accountPool.getAllAccounts();
                const exclude = new Set();
                for (const a of allAccounts) {
                    if (!isAllowed(a))
                        exclude.add(a.id);
                }
                account = this.accountPool.getNextAccount(exclude);
            }
            if (!account) {
                const status = this.accountPool.getQuotaStatus();
                if (status.exhausted > 0 && status.available === 0) {
                    console.log(`[ProxyServer] All accounts quota exhausted (${status.exhausted}/${status.total}), no available accounts`);
                }
            }
        }
        else {
            // When multi-account polling is disabled, the specified account will be used first.
            if (this.config.selectedAccountIds && this.config.selectedAccountIds.length > 0) {
                // Use the first account specified
                account = this.accountPool.getAccount(this.config.selectedAccountIds[0]);
                // Check whether the quota of the specified account is exhausted, and if so, try to automatically switch
                if (account && this.accountPool.isQuotaExhausted(account) && this.config.autoSwitchOnQuotaExhausted) {
                    const nextAccount = this.accountPool.getNextAvailableAccount(account.id);
                    if (nextAccount) {
                        console.log(`[ProxyServer] Selected account ${account.email || account.id} quota exhausted, auto-switching to ${nextAccount.email || nextAccount.id}`);
                        this.config.selectedAccountIds = [nextAccount.id];
                        this.events.onAccountUpdate?.(nextAccount);
                        account = nextAccount;
                    }
                }
                if (!account) {
                    console.log(`[ProxyServer] Selected account ${this.config.selectedAccountIds[0]} not found, using first available`);
                    const allAccounts = this.accountPool.getAllAccounts();
                    account = allAccounts.length > 0 ? allAccounts[0] : null;
                }
            }
            else {
                // If no account is specified, the first available account is used.
                const allAccounts = this.accountPool.getAllAccounts();
                account = allAccounts.length > 0 ? allAccounts[0] : null;
            }
        }
        if (!account)
            return null;
        // Automatic switching K-Proxy equipment ID(if K-Proxy service available)
        this.syncKProxyDeviceId(account);
        // Check if refresh is needed Token
        if (this.isTokenExpiringSoon(account)) {
            const refreshed = await this.refreshToken(account, signal);
            if (!refreshed) {
                // Refresh failed. If multiple accounts are enabled, try to get the next account.
                if (this.config.enableMultiAccount) {
                    return this.accountPool.getNextAccount();
                }
                return null;
            }
            // Return to updated account
            const refreshedAccount = this.accountPool.getAccount(account.id);
            if (refreshedAccount && sessionHint)
                this.rememberAffinity(sessionHint, refreshedAccount.id);
            return refreshedAccount;
        }
        if (sessionHint)
            this.rememberAffinity(sessionHint, account.id);
        return account;
    }
    // synchronous K-Proxy equipment ID(Automatically switch based on account)
    syncKProxyDeviceId(account) {
        const kproxyService = (0, kproxy_1.getKProxyService)();
        if (!kproxyService || !kproxyService.isRunning()) {
            return; // K-Proxy Not initialized or not running
        }
        // Try switching to the device bound to the account ID
        const switched = kproxyService.switchToAccount(account.id);
        if (!switched) {
            // The account is not bound to a device ID, automatically generated and bound
            const newDeviceId = (0, kproxy_1.generateDeviceId)();
            kproxyService.addDeviceIdMapping({
                accountId: account.id,
                deviceId: newDeviceId,
                description: account.email || `Account ${account.id.substring(0, 8)}`,
                createdAt: Date.now()
            });
            kproxyService.setDeviceId(newDeviceId);
            logger_1.proxyLogger.info('ProxyServer', `Auto-generated device ID for account ${account.email || account.id.substring(0, 8)}`);
        }
        else {
            logger_1.proxyLogger.debug('ProxyServer', `Switched to device ID for account ${account.email || account.id.substring(0, 8)}`);
        }
    }
    // With retry API call
    async callWithRetry(account, apiCall, _path, signal) {
        const maxRetries = this.config.maxRetries || 3;
        const retryDelay = this.config.retryDelayMs || 1000;
        let lastError = null;
        let currentAccount = account;
        let endpointIndex = 0;
        // The total number of accounts that have been tried for this request ID, to avoid looping through accounts that have failed when retrying.
        const triedIds = new Set([account.id]);
        /** Switch to the next available account; multi-account mode with triedIds Excluded, the single-account scenario degrades to the old logic */
        const switchToNextAccount = () => {
            if (this.config.enableMultiAccount) {
                return this.accountPool.getNextAccount(triedIds);
            }
            if (this.config.autoSwitchOnQuotaExhausted) {
                return this.accountPool.getNextAvailableAccount(triedIds);
            }
            return null;
        };
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            this.throwIfAborted(signal);
            try {
                const result = await apiCall(currentAccount, endpointIndex);
                return { result, account: currentAccount };
            }
            catch (error) {
                if (this.isAbortError(error, signal))
                    throw error;
                lastError = error;
                const errMsg = lastError.message || '';
                console.log(`[ProxyServer] API call failed (attempt ${attempt + 1}/${maxRetries}): ${errMsg}`);
                // Prioritize detection of accounts that have been banned for a long time (not token Problem, refreshing doesn’t work either)
                // feature:HTTP 403 + reason: "TEMPORARILY_SUSPENDED" or AccountSuspendedException / 423
                const suspendInfo = this.detectSuspendedError(errMsg);
                if (suspendInfo) {
                    const newlyMarked = this.accountPool.markSuspended(currentAccount.id, suspendInfo.reason, suspendInfo.message);
                    if (newlyMarked) {
                        this.events.onAccountSuspended?.({
                            accountId: currentAccount.id,
                            email: currentAccount.email,
                            reason: suspendInfo.reason,
                            message: suspendInfo.message
                        });
                        // P1-6 key events → trigger webhook
                        this.appendAuditLog('account_suspended', {
                            accountId: currentAccount.id,
                            email: currentAccount.email,
                            reason: suspendInfo.reason
                        });
                        this.triggerWebhook('proxy-account-suspended', {
                            title: 'Anti-generation accounts are subject to risk control',
                            message: `account ${currentAccount.email || currentAccount.id.slice(0, 8)} quilt Kiro The backend is marked as ${suspendInfo.reason}, need to be manually unblocked`,
                            level: 'error',
                            fields: {
                                Mail: currentAccount.email || '-',
                                accountID: currentAccount.id.slice(0, 8),
                                'Ban reason': suspendInfo.reason,
                                Details: this.sanitizeErrorMessage(suspendInfo.message || '').slice(0, 200)
                            }
                        });
                    }
                    console.warn(`[ProxyServer] Account ${currentAccount.email || currentAccount.id} suspended (${suspendInfo.reason}), switching to next available account`);
                    // Switch to the next available account (skip being suspended of + This request has been tried)
                    const nextAccount = switchToNextAccount();
                    if (nextAccount && !triedIds.has(nextAccount.id)) {
                        currentAccount = nextAccount;
                        triedIds.add(nextAccount.id);
                        if (!this.config.enableMultiAccount) {
                            this.config.selectedAccountIds = [nextAccount.id];
                            this.events.onAccountUpdate?.(nextAccount);
                        }
                        continue;
                    }
                    // Accounts that cannot be switched → Throw errors directly to the client
                    break;
                }
                // 401/403: try to refresh Token
                if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Auth')) {
                    console.log('[ProxyServer] Auth error, attempting token refresh');
                    const refreshed = await this.refreshToken(currentAccount, signal);
                    if (refreshed) {
                        currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount;
                        continue;
                    }
                    // Refresh failed → Switch to the next account you haven’t tried yet
                    const nextAccount = switchToNextAccount();
                    if (nextAccount && !triedIds.has(nextAccount.id)) {
                        currentAccount = nextAccount;
                        triedIds.add(nextAccount.id);
                        continue;
                    }
                }
                // 402/429: The quota is exhausted, switch the endpoint or account
                if (errMsg.includes('402') || errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('ThrottlingException') || errMsg.includes('reached the limit') || errMsg.includes('ServiceQuotaExceededException') || errMsg.includes('limit exceeded') || errMsg.includes('rate limit')) {
                    console.log('[ProxyServer] Quota/throttle error, switching endpoint or account');
                    this.accountPool.recordError(currentAccount.id, accountPool_1.ErrorType.RECOVERABLE, 429);
                    endpointIndex = (endpointIndex + 1) % 2; // Switch endpoint
                    if (endpointIndex === 0) {
                        // All endpoints have been tried, switch to the next account that has not been tried yet
                        const nextAccount = switchToNextAccount();
                        if (nextAccount && !triedIds.has(nextAccount.id)) {
                            console.log(`[ProxyServer] Auto-switching to ${nextAccount.email || nextAccount.id.slice(0, 8)} due to quota exhausted`);
                            currentAccount = nextAccount;
                            triedIds.add(nextAccount.id);
                            if (!this.config.enableMultiAccount) {
                                this.config.selectedAccountIds = [nextAccount.id];
                                this.events.onAccountUpdate?.(nextAccount);
                            }
                        }
                    }
                    continue;
                }
                // 5xx: Short backoff and try again with the same account; again 5xx direct fallback to an account that has not been tried before (instantaneous failure can be bypassed across accounts)
                if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('504')) {
                    console.log('[ProxyServer] Server error, retrying');
                    // the second time and subsequent 5xx → Switch accounts (the old logic will be killed by the same account)
                    if (attempt > 0) {
                        const nextAccount = switchToNextAccount();
                        if (nextAccount && !triedIds.has(nextAccount.id)) {
                            console.log(`[ProxyServer] Persistent 5xx on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`);
                            currentAccount = nextAccount;
                            triedIds.add(nextAccount.id);
                            continue;
                        }
                    }
                    await this.waitForRetry(retryDelay * (attempt + 1), signal);
                    continue;
                }
                // Other errors, no retry
                break;
            }
        }
        throw lastError || new Error('Unknown error');
    }
    /**
     * Constant time string comparison (anti-timing attacks)
     * Return if the length is different false But still go once timingSafeEqual prevent bypass
     */
    safeStringEq(a, b) {
        // Buffer.from deal with UTF-8 coding
        const ab = Buffer.from(a, 'utf8');
        const bb = Buffer.from(b, 'utf8');
        if (ab.length !== bb.length) {
            // Still performs a comparison guaranteed to be constant time (using a self-ratio, the result will not be affected)
            try {
                crypto_1.default.timingSafeEqual(ab, ab);
            }
            catch { /* ignore */ }
            return false;
        }
        try {
            return crypto_1.default.timingSafeEqual(ab, bb);
        }
        catch {
            return false;
        }
    }
    // verify API Key and return matching Key(for statistics)
    // P0-3 use timingSafeEqual Prevent timing attacks from word-for-word guessing Key
    validateApiKey(req) {
        // If not configured any API Key, then skip verification
        const hasApiKeys = this.config.apiKeys && this.config.apiKeys.length > 0;
        const hasLegacyKey = !!this.config.apiKey;
        if (!hasApiKeys && !hasLegacyKey)
            return { valid: true };
        // from Authorization head or X-Api-Key Header acquisition API Key
        const authHeader = req.headers['authorization'] || '';
        const apiKeyHeader = req.headers['x-api-key'] || '';
        let providedKey = '';
        // Bearer token Format
        if (authHeader.startsWith('Bearer ')) {
            providedKey = authHeader.slice(7);
        }
        // direct API Key Format
        if (!providedKey && apiKeyHeader) {
            providedKey = apiKeyHeader;
        }
        if (!providedKey)
            return { valid: false };
        // Check many API Key(constant time comparison)
        if (hasApiKeys) {
            let matched;
            for (const k of this.config.apiKeys) {
                if (!k.enabled || !k.key)
                    continue;
                if (this.safeStringEq(k.key, providedKey)) {
                    matched = k;
                    // No break: Continue traversing to keep the time consistent (small number of arrays OK）
                }
            }
            if (matched) {
                if (matched.creditsLimit && matched.usage.totalCredits >= matched.creditsLimit) {
                    return { valid: false, reason: 'Credits limit exceeded' };
                }
                return { valid: true, apiKey: matched };
            }
        }
        // Compatible with old single API Key(constant time comparison)
        if (hasLegacyKey && this.safeStringEq(this.config.apiKey, providedKey)) {
            return { valid: true };
        }
        return { valid: false };
    }
    /**
     * P0-4 IP access control
     * - deniedIPs Priority: hit and reject
     * - allowedIPs After configuration: must be in the list (whitelist mode)
     * - Neither configured: Allowed
     * Support ticket IP and CIDR（IPv4 / IPv6 simplified processing)
     */
    isClientIPAllowed(clientIP) {
        if (!clientIP)
            return { allowed: true };
        // normalized (::ffff:1.2.3.4 → 1.2.3.4）
        const ip = clientIP.startsWith('::ffff:') ? clientIP.slice(7) : clientIP;
        const matchEntry = (entry) => {
            const e = entry.trim();
            if (!e)
                return false;
            // CIDR
            if (e.includes('/')) {
                return this.ipInCidr(ip, e);
            }
            return e === ip;
        };
        const denied = this.config.deniedIPs?.find(matchEntry);
        if (denied)
            return { allowed: false, reason: `IP ${ip} matches denied entry ${denied}` };
        const allowList = this.config.allowedIPs;
        if (allowList && allowList.length > 0) {
            const allowed = allowList.some(matchEntry);
            if (!allowed)
                return { allowed: false, reason: `IP ${ip} not in allowed list` };
        }
        return { allowed: true };
    }
    /**
     * simplify IPv4/IPv6 CIDR Matching (does not rely on external libraries)
     * IPv4 CIDR：1.2.3.0/24；IPv6 CIDR: Prefix only bit Compare
     */
    ipInCidr(ip, cidr) {
        const [range, bitsStr] = cidr.split('/');
        const bits = parseInt(bitsStr, 10);
        if (!Number.isFinite(bits))
            return false;
        const isV4 = ip.includes('.') && range.includes('.');
        if (isV4) {
            const ipNum = this.ipv4ToInt(ip);
            const rangeNum = this.ipv4ToInt(range);
            if (ipNum < 0 || rangeNum < 0)
                return false;
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            return (ipNum & mask) === (rangeNum & mask);
        }
        // IPv6 Simplification: Convert to byte array + Prefix by bit Compare
        const ipBytes = this.ipv6ToBytes(ip);
        const rangeBytes = this.ipv6ToBytes(range);
        if (!ipBytes || !rangeBytes)
            return false;
        let bitsLeft = bits;
        for (let i = 0; i < 16 && bitsLeft > 0; i++) {
            if (bitsLeft >= 8) {
                if (ipBytes[i] !== rangeBytes[i])
                    return false;
                bitsLeft -= 8;
            }
            else {
                const mask = (0xff << (8 - bitsLeft)) & 0xff;
                if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask))
                    return false;
                bitsLeft = 0;
            }
        }
        return true;
    }
    ipv4ToInt(ip) {
        const parts = ip.split('.').map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255))
            return -1;
        return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
    ipv6ToBytes(ip) {
        try {
            // Simplified processing: supported :: abbreviation
            const parts = ip.split('::');
            let head = [];
            let tail = [];
            if (parts.length === 1) {
                head = parts[0].split(':');
            }
            else if (parts.length === 2) {
                head = parts[0] ? parts[0].split(':') : [];
                tail = parts[1] ? parts[1].split(':') : [];
            }
            else {
                return null;
            }
            const missing = 8 - head.length - tail.length;
            if (missing < 0)
                return null;
            const segments = [...head, ...new Array(missing).fill('0'), ...tail];
            const bytes = new Uint8Array(16);
            for (let i = 0; i < 8; i++) {
                const v = parseInt(segments[i] || '0', 16);
                if (!Number.isFinite(v) || v < 0 || v > 0xffff)
                    return null;
                bytes[i * 2] = (v >> 8) & 0xff;
                bytes[i * 2 + 1] = v & 0xff;
            }
            return bytes;
        }
        catch {
            return null;
        }
    }
    /** Get client real IP(distrust X-Forwarded-For, only take socket address） */
    getClientIP(req) {
        return req.socket.remoteAddress || '';
    }
    // Record API Key Dosage
    recordApiKeyUsage(apiKeyId, credits, inputTokens, outputTokens, model, path) {
        if (!this.config.apiKeys)
            return;
        const apiKey = this.config.apiKeys.find(k => k.id === apiKeyId);
        if (!apiKey)
            return;
        const today = new Date().toISOString().split('T')[0];
        const now = Date.now();
        // Update total
        apiKey.usage.totalRequests++;
        apiKey.usage.totalCredits += credits;
        apiKey.usage.totalInputTokens += inputTokens;
        apiKey.usage.totalOutputTokens += outputTokens;
        apiKey.lastUsedAt = now;
        // Update daily statistics
        if (!apiKey.usage.daily[today]) {
            apiKey.usage.daily[today] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 };
        }
        apiKey.usage.daily[today].requests++;
        apiKey.usage.daily[today].credits += credits;
        apiKey.usage.daily[today].inputTokens += inputTokens;
        apiKey.usage.daily[today].outputTokens += outputTokens;
        // Update model statistics
        if (model) {
            if (!apiKey.usage.byModel) {
                apiKey.usage.byModel = {};
            }
            if (!apiKey.usage.byModel[model]) {
                apiKey.usage.byModel[model] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 };
            }
            apiKey.usage.byModel[model].requests++;
            apiKey.usage.byModel[model].credits += credits;
            apiKey.usage.byModel[model].inputTokens += inputTokens;
            apiKey.usage.byModel[model].outputTokens += outputTokens;
        }
        // Add usage history (keep recent 100 strip)
        if (!apiKey.usageHistory) {
            apiKey.usageHistory = [];
        }
        apiKey.usageHistory.unshift({
            timestamp: now,
            model: model || 'unknown',
            inputTokens,
            outputTokens,
            credits,
            path: path || 'unknown'
        });
        if (apiKey.usageHistory.length > 100) {
            apiKey.usageHistory = apiKey.usageHistory.slice(0, 100);
        }
        // Trigger configuration save event
        this.events.onConfigChanged?.(this.config);
    }
    // Apply model mapping
    applyModelMapping(requestedModel, apiKeyId) {
        const mappings = this.config.modelMappings;
        if (!mappings || mappings.length === 0)
            return requestedModel;
        // Sort by priority (lower numbers have higher priority)
        const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority);
        for (const rule of sortedMappings) {
            // Check if the rule is enabled
            if (!rule.enabled)
                continue;
            // Check if it applies to the current API Key
            if (rule.apiKeyIds && rule.apiKeyIds.length > 0 && apiKeyId) {
                if (!rule.apiKeyIds.includes(apiKeyId))
                    continue;
            }
            // Check if the source model matches (supports wildcards *）
            const sourcePattern = rule.sourceModel.replace(/\*/g, '.*');
            const regex = new RegExp(`^${sourcePattern}$`, 'i');
            if (!regex.test(requestedModel))
                continue;
            // Match successful, select target model based on type
            const validTargets = rule.targetModels.filter(t => t.trim());
            if (validTargets.length === 0)
                continue;
            let targetModel;
            if (rule.type === 'loadbalance' && validTargets.length > 1) {
                // Load balancing: random selection based on weight
                const weights = rule.weights || validTargets.map(() => 1);
                const totalWeight = weights.reduce((a, b) => a + b, 0);
                let random = Math.random() * totalWeight;
                let selectedIndex = 0;
                for (let i = 0; i < weights.length; i++) {
                    random -= weights[i];
                    if (random <= 0) {
                        selectedIndex = i;
                        break;
                    }
                }
                targetModel = validTargets[selectedIndex];
            }
            else {
                // replace or alias: Use the first target directly
                targetModel = validTargets[0];
            }
            logger_1.proxyLogger.info('ProxyServer', `Model mapping applied: ${requestedModel} -> ${targetModel} (rule: ${rule.name}, type: ${rule.type})`);
            return targetModel;
        }
        return requestedModel;
    }
    // Handle request
    async handleRequest(req, res) {
        const path = req.url || '/';
        const method = req.method || 'GET';
        const clientIP = this.getClientIP(req);
        const controller = new AbortController();
        const abortRequest = () => {
            if (!this.isStopping && res.writableEnded)
                return;
            if (!controller.signal.aborted) {
                controller.abort(new Error(this.isStopping ? 'Proxy server stopped' : 'Client disconnected'));
            }
        };
        this.activeRequests.add(controller);
        req.on('aborted', abortRequest);
        res.on('close', abortRequest);
        // CORS Preflight
        if (method === 'OPTIONS') {
            this.setCorsHeaders(res);
            res.writeHead(204);
            res.end();
            req.off('aborted', abortRequest);
            res.off('close', abortRequest);
            this.activeRequests.delete(controller);
            return;
        }
        try {
            this.setCorsHeaders(res);
            // P0-4 IP Access control (health checks also go, prevent scanners)
            const ipCheck = this.isClientIPAllowed(clientIP);
            if (!ipCheck.allowed) {
                logger_1.proxyLogger.warn('ProxyServer', `Blocked request from ${clientIP}: ${ipCheck.reason}`);
                this.appendAuditLog('ip_blocked', { ip: clientIP, path, reason: ipCheck.reason });
                this.sendError(res, 403, 'Forbidden');
                return;
            }
            // API Key Authentication (except health check endpoints)
            if (path !== '/health' && path !== '/') {
                const authResult = this.validateApiKey(req);
                if (!authResult.valid) {
                    const errorMsg = authResult.reason || 'Invalid or missing API key';
                    const statusCode = authResult.reason === 'Credits limit exceeded' ? 429 : 401;
                    // 401 Do not return reason Details (prevent fingerprint crawling)
                    this.sendError(res, statusCode, statusCode === 401 ? 'Unauthorized' : errorMsg, this.isAnthropicPath(path) ? 'anthropic' : 'openai');
                    return;
                }
                // will match API Key Stored in the request object for subsequent statistics
                ;
                req.matchedApiKey = authResult.apiKey;
                // P1-7 according to API Key(or if anonymous, press IP) request current limit
                const rateLimitId = authResult.apiKey?.id || `ip:${clientIP || 'unknown'}`;
                const rl = this.checkRateLimit(rateLimitId);
                if (!rl.allowed) {
                    res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
                    res.setHeader('X-RateLimit-Limit', String(this.config.rateLimitPerKeyPerMinute || 0));
                    res.setHeader('X-RateLimit-Remaining', '0');
                    this.sendError(res, 429, 'Rate limit exceeded', this.isAnthropicPath(path) ? 'anthropic' : 'openai');
                    return;
                }
            }
            // Logging request
            if (this.config.logRequests) {
                logger_1.proxyLogger.info('ProxyServer', `${method} ${path}`);
            }
            // Routing (remove query parameters)
            const pathWithoutQuery = path.split('?')[0];
            if (pathWithoutQuery === '/v1/models' || pathWithoutQuery === '/models') {
                await this.handleModels(res, controller.signal);
            }
            else if (pathWithoutQuery === '/v1/chat/completions' || pathWithoutQuery === '/chat/completions') {
                await this.handleOpenAIChat(req, res, controller.signal);
            }
            else if (pathWithoutQuery === '/v1/responses' || pathWithoutQuery === '/responses') {
                await this.handleOpenAIResponses(req, res, controller.signal);
            }
            else if (pathWithoutQuery === '/v1/messages' || pathWithoutQuery === '/messages' || pathWithoutQuery === '/anthropic/v1/messages') {
                await this.handleClaudeMessages(req, res, controller.signal);
            }
            else if (pathWithoutQuery === '/v1/messages/count_tokens' || pathWithoutQuery === '/messages/count_tokens') {
                // Claude Code token Count endpoint - Return mock response
                await this.handleCountTokens(req, res, controller.signal);
            }
            else if (pathWithoutQuery === '/api/event_logging/batch') {
                // Claude Code telemetry endpoint - Return directly 200 OK
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok' }));
            }
            else if (pathWithoutQuery.startsWith('/v1beta/models/')) {
                // Gemini v1beta Compatible routing
                await this.handleGeminiRequest(req, res, pathWithoutQuery, controller.signal);
            }
            else if (pathWithoutQuery === '/v1beta/models') {
                // Gemini Model list
                await this.handleGeminiModels(res, controller.signal);
            }
            else if (pathWithoutQuery === '/health' || pathWithoutQuery === '/') {
                this.handleHealth(res);
            }
            else if (pathWithoutQuery === '/metrics' && this.config.enableMetrics) {
                // P2-16 Prometheus metrics
                res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
                res.end(this.renderPrometheusMetrics());
            }
            else if (pathWithoutQuery.startsWith('/admin/')) {
                // manage API endpoint
                await this.handleAdminApi(req, res, pathWithoutQuery, controller.signal);
            }
            else {
                // Logging unknown paths for debugging
                console.log(`[ProxyServer] Unknown path: ${path} (method: ${method})`);
                this.sendError(res, 404, `Not Found: ${pathWithoutQuery}`);
            }
        }
        catch (error) {
            if (this.isAbortError(error, controller.signal)) {
                logger_1.proxyLogger.info('ProxyServer', `Request aborted: ${method} ${path}`);
                return;
            }
            // P0-1 body Over limit → 413
            if (error instanceof BodyTooLargeError) {
                logger_1.proxyLogger.warn('ProxyServer', `Body too large from ${clientIP}: ${error.received}/${error.limit} bytes (${path})`);
                this.sendError(res, 413, `Request body too large (max ${error.limit} bytes)`, this.isAnthropicPath(path) ? 'anthropic' : 'openai');
                return;
            }
            // P0-5 error response sanitize：500 Class does not spit internal message
            console.error('[ProxyServer] Request error:', error);
            this.sendError(res, 500, 'Internal server error', this.isAnthropicPath(path) ? 'anthropic' : 'openai');
            this.events.onError?.(error);
        }
        finally {
            req.off('aborted', abortRequest);
            res.off('close', abortRequest);
            this.activeRequests.delete(controller);
        }
    }
    // manage API endpoint
    async handleAdminApi(req, res, path, signal) {
        const method = req.method || 'GET';
        // manage API need API Key verify
        const authResult = this.validateApiKey(req);
        if (!authResult.valid) {
            this.sendError(res, 401, 'Admin API requires authentication');
            return;
        }
        if (path === '/admin/stats' && method === 'GET') {
            // Get detailed statistics
            this.handleAdminStats(res);
        }
        else if (path === '/admin/accounts' && method === 'GET') {
            // Get account list
            this.handleAdminAccounts(res);
        }
        else if (path === '/admin/config' && method === 'GET') {
            // Get configuration
            this.handleAdminConfig(res);
        }
        else if (path === '/admin/config' && method === 'POST') {
            // update configuration (P1-9 schema Whitelist verification to prevent arbitrary field injection)
            const body = await this.readBody(req, signal);
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                this.sendError(res, 400, 'Invalid JSON body');
                return;
            }
            const safeUpdate = this.filterAdminConfigUpdate(parsed);
            this.updateConfig(safeUpdate);
            this.appendAuditLog('config_updated', { fields: Object.keys(safeUpdate) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, applied: Object.keys(safeUpdate), config: this.handleAdminConfigPayload() }));
        }
        else if (path === '/admin/audit' && method === 'GET') {
            // P2-17 Audit log
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ entries: this.auditLog.slice(-100) }));
        }
        else if (path === '/admin/logs' && method === 'GET') {
            // Get recent logs
            this.handleAdminLogs(res);
        }
        else if (path === '/admin/cache/clear' && method === 'POST') {
            // Clear memory cache (conversationId Mapping, model caching,prompt cache）
            const { clearAllCaches } = require('./kiroApi');
            const cleared = clearAllCaches();
            const promptCacheCleared = promptCacheTracker_1.promptCacheTracker.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, cleared: { ...cleared, promptCache: promptCacheCleared } }));
        }
        else {
            this.sendError(res, 404, 'Admin endpoint not found');
        }
    }
    // manage API - Detailed statistics
    handleAdminStats(res) {
        const stats = this.getStats();
        const accountStats = {};
        stats.accountStats.forEach((v, k) => { accountStats[k] = v; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            totalRequests: stats.totalRequests,
            successRequests: stats.successRequests,
            failedRequests: stats.failedRequests,
            totalTokens: stats.totalTokens,
            inputTokens: stats.inputTokens,
            outputTokens: stats.outputTokens,
            uptime: Date.now() - stats.startTime,
            startTime: stats.startTime,
            accountStats,
            recentRequests: stats.recentRequests.slice(-50)
        }));
    }
    // manage API - Account list
    handleAdminAccounts(res) {
        const accounts = this.accountPool.getAllAccounts().map(acc => ({
            id: acc.id,
            email: acc.email,
            isAvailable: acc.isAvailable !== false,
            lastUsed: acc.lastUsed,
            requestCount: acc.requestCount || 0,
            errorCount: acc.errorCount || 0,
            expiresAt: acc.expiresAt,
            authMethod: acc.authMethod
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            total: accounts.length,
            available: accounts.filter(a => a.isAvailable).length,
            accounts
        }));
    }
    /**
     * P1-12 Construct the configuration after desensitization (apiKeys[].key All desensitized,tls Private key is not returned)
     * exposed to /admin/config GET
     */
    handleAdminConfigPayload() {
        const config = this.getConfig();
        const maskKey = (k) => {
            if (!k)
                return undefined;
            if (k.length <= 8)
                return '***';
            return `${k.slice(0, 4)}***${k.slice(-4)}`;
        };
        return {
            ...config,
            apiKey: maskKey(config.apiKey),
            apiKeys: config.apiKeys?.map(k => ({ ...k, key: maskKey(k.key) || '***' })),
            tls: config.tls ? { enabled: config.tls.enabled, hasCert: !!(config.tls.cert || config.tls.certPath), hasKey: !!(config.tls.key || config.tls.keyPath) } : undefined
        };
    }
    // manage API - Configuration
    handleAdminConfig(res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.handleAdminConfigPayload()));
    }
    /**
     * P1-9 admin/config POST Field whitelist filtering
     * only allowed"Can be changed remotely"fields;apiKeys/apiKey Sensitive fields such as these must be passed through the local IPC change
     */
    filterAdminConfigUpdate(input) {
        const allowed = [
            'enabled', 'enableMultiAccount', 'logRequests', 'logStreamEvents',
            'maxConcurrent', 'maxRetries', 'retryDelayMs', 'preferredEndpoint',
            'tokenRefreshBeforeExpiry', 'autoStart', 'clientDrivenToolExecution',
            'disableTools', 'payloadSizeLimitKB', 'enableTokenBufferReserve',
            'tokenBufferReserve', 'autoSwitchOnQuotaExhausted', 'accountSelectionStrategy',
            'multiAccountSelectionMode', 'multiAccountGroupIds', 'modelMappings',
            'maxRequestBodyBytes', 'allowedIPs', 'deniedIPs',
            'rateLimitPerKeyPerMinute', 'sessionAffinityEnabled',
            'keepAliveTimeoutMs', 'headersTimeoutMs', 'recentRequestsLimit',
            'enableMetrics', 'apiKeyGroupBindings', 'enableAuditLog'
            // Deliberately excluded:port / host / apiKey / apiKeys / tls / fallbackPort / allowExternalWithoutApiKey
            // These fields will change the listening behavior or security policy and must be local IPC change
        ];
        const out = {};
        for (const key of allowed) {
            if (key in input) {
                out[key] = input[key];
            }
        }
        return out;
    }
    // manage API - log
    handleAdminLogs(res) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            recentRequests: this.stats.recentRequests.slice(-100)
        }));
    }
    // set up CORS head
    setCorsHeaders(res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch');
        res.setHeader('Access-Control-Expose-Headers', 'x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens');
    }
    isAnthropicPath(path) {
        const pathWithoutQuery = path.split('?')[0];
        return pathWithoutQuery === '/v1/messages'
            || pathWithoutQuery === '/messages'
            || pathWithoutQuery === '/anthropic/v1/messages'
            || pathWithoutQuery === '/v1/messages/count_tokens'
            || pathWithoutQuery === '/messages/count_tokens';
    }
    getAnthropicErrorType(status) {
        if (status === 400)
            return 'invalid_request_error';
        if (status === 401)
            return 'authentication_error';
        if (status === 403)
            return 'permission_error';
        if (status === 404)
            return 'not_found_error';
        if (status === 429)
            return 'rate_limit_error';
        return 'api_error';
    }
    buildClaudeUsage(usage, simulatedCache) {
        // priority use Kiro The truth returned by the backend cache tokens, otherwise use the value of the simulator
        const cacheWrite = usage.cacheWriteTokens || simulatedCache?.cacheCreationInputTokens || 0;
        const cacheRead = usage.cacheReadTokens || simulatedCache?.cacheReadInputTokens || 0;
        // Kiro of inputTokens It is the full amount (including cache),Anthropic API In specification input_tokens Without cache part
        // Need to deduct cache tokens Avoid double billing on the client side
        const adjustedInput = Math.max(0, usage.inputTokens - cacheWrite - cacheRead);
        return {
            input_tokens: adjustedInput,
            output_tokens: usage.outputTokens,
            ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
            ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {})
        };
    }
    estimateTokenCount(value) {
        if (value === null || value === undefined)
            return 0;
        if (typeof value === 'string')
            return Math.ceil(value.length / 4);
        if (typeof value === 'number' || typeof value === 'boolean')
            return 1;
        if (Array.isArray(value)) {
            return value.reduce((total, item) => total + this.estimateTokenCount(item), 0);
        }
        if (typeof value !== 'object')
            return 0;
        const record = value;
        if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text')
            return this.estimateTokenCount(record.text) + 4;
        if (record.type === 'thinking')
            return this.estimateTokenCount(record.thinking) + this.estimateTokenCount(record.signature) + 4;
        if (record.type === 'redacted_thinking')
            return 8;
        if (record.type === 'image' || record.type === 'input_image')
            return 170;
        if (record.type === 'document' || record.type === 'input_file')
            return this.estimateTokenCount(record.title) + this.estimateTokenCount(record.name) + this.estimateTokenCount(record.filename) + this.estimateTokenCount(record.source) + this.estimateTokenCount(record.file_data) + 120;
        if (record.type === 'tool_use')
            return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.input) + 12;
        if (record.type === 'tool_result')
            return this.estimateTokenCount(record.content) + 8;
        if (typeof record.role === 'string' && 'content' in record)
            return this.estimateTokenCount(record.content) + 4;
        if (typeof record.name === 'string' && 'input_schema' in record)
            return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.description) + this.estimateTokenCount(record.input_schema) + 32;
        return Object.entries(record).reduce((total, [key, item]) => key === 'cache_control' ? total : total + this.estimateTokenCount(item), 0);
    }
    // health check
    handleHealth(res) {
        const stats = this.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            version: '1.0.0',
            accounts: this.accountPool.size,
            availableAccounts: this.accountPool.availableCount,
            stats: {
                totalRequests: stats.totalRequests,
                successRequests: stats.successRequests,
                failedRequests: stats.failedRequests,
                totalTokens: stats.totalTokens,
                uptime: Date.now() - stats.startTime
            }
        }));
    }
    // Claude Code token count (analog response)
    async handleCountTokens(req, res, signal) {
        try {
            this.throwIfAborted(signal);
            const body = await this.readBody(req, signal);
            this.throwIfAborted(signal);
            const request = JSON.parse(body);
            if (!Array.isArray(request.messages)) {
                throw new Error('count_tokens requires messages');
            }
            const estimatedTokens = Math.max(1, this.estimateTokenCount(request.system) + this.estimateTokenCount(request.messages) + this.estimateTokenCount(request.tools));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ input_tokens: estimatedTokens }));
        }
        catch (error) {
            if (this.isAbortError(error, signal))
                return;
            this.sendError(res, 400, error instanceof Error ? error.message : 'Invalid request body', 'anthropic');
        }
    }
    // Gemini v1beta Model list
    async handleGeminiModels(res, signal) {
        const result = await this.getAvailableModels(signal);
        const geminiModels = result.models.map(m => ({
            name: `models/${m.id}`,
            version: '001',
            displayName: m.name || m.id,
            description: m.description || '',
            inputTokenLimit: m.maxInputTokens || 200000,
            outputTokenLimit: m.maxOutputTokens || 64000,
            supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
        }));
        this.throwIfResponseClosed(res, signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: geminiModels }));
    }
    // Gemini v1beta generateContent / streamGenerateContent
    async handleGeminiRequest(req, res, path, signal) {
        const body = await this.readBody(req, signal);
        this.throwIfAborted(signal);
        const geminiReq = JSON.parse(body);
        const matchedApiKey = req.matchedApiKey;
        // parse path: /v1beta/models/{model}:{method}
        const match = path.match(/\/v1beta\/models\/([^:]+):(\w+)/);
        if (!match) {
            this.sendError(res, 400, 'Invalid Gemini endpoint path');
            return;
        }
        const [, modelId, method] = match;
        const isStream = method === 'streamGenerateContent';
        // Will Gemini Request to convert to OpenAI Format
        const messages = [];
        if (geminiReq.systemInstruction?.parts) {
            const sysText = geminiReq.systemInstruction.parts.map((p) => p.text || '').join('\n');
            if (sysText)
                messages.push({ role: 'system', content: sysText });
        }
        for (const content of geminiReq.contents || []) {
            const role = content.role === 'model' ? 'assistant' : 'user';
            const text = (content.parts || []).map((p) => p.text || '').join('');
            if (text)
                messages.push({ role: role, content: text });
        }
        if (messages.length === 0) {
            messages.push({ role: 'user', content: 'Hello' });
        }
        const openaiRequest = {
            model: this.applyModelMapping(modelId, matchedApiKey?.id),
            messages,
            stream: isStream,
            temperature: geminiReq.generationConfig?.temperature,
            top_p: geminiReq.generationConfig?.topP,
            max_tokens: geminiReq.generationConfig?.maxOutputTokens
        };
        // Reuse OpenAI process
        const startTime = Date.now();
        this.recordNewRequest();
        this.throwIfAborted(signal);
        const account = await this.getAvailableAccount(signal);
        this.throwIfAborted(signal);
        if (!account) {
            this.sendError(res, 503, 'No available accounts');
            return;
        }
        try {
            // Make sure the model cache is loaded to support thinkingConfig Query
            await this.getAvailableModels(signal);
            const toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry();
            const kiroPayload = (0, translator_1.openaiToKiro)(openaiRequest, account.profileArn, toolNameRegistry, this.getThinkingConfig(openaiRequest.model));
            if (isStream) {
                // SSE streaming
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                return new Promise((resolve) => {
                    (0, kiroApi_1.callKiroApiStream)(account, kiroPayload, (text) => {
                        if (signal?.aborted || this.isResponseClosed(res))
                            return;
                        if (text) {
                            const chunk = { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: null }] };
                            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        }
                        return this.waitForDrain(res);
                    }, (usage) => {
                        if (signal?.aborted || this.isResponseClosed(res)) {
                            resolve();
                            return;
                        }
                        const finalChunk = { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens, totalTokenCount: usage.inputTokens + usage.outputTokens } };
                        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                        res.end();
                        this.recordRequestSuccess();
                        this.stats.totalTokens += usage.inputTokens + usage.outputTokens;
                        this.stats.inputTokens += usage.inputTokens;
                        this.stats.outputTokens += usage.outputTokens;
                        this.stats.totalCredits += usage.credits || 0;
                        this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens);
                        resolve();
                    }, (error) => {
                        if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                            resolve();
                            return;
                        }
                        res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                        res.end();
                        this.recordRequestFailed();
                        resolve();
                    }, signal, this.config.preferredEndpoint).catch(error => {
                        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
                            res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                            res.end();
                            this.recordRequestFailed();
                        }
                        resolve();
                    });
                });
            }
            else {
                // non-streaming
                const result = await (0, kiroApi_1.callKiroApi)(account, kiroPayload, signal);
                this.throwIfResponseClosed(res, signal);
                this.recordRequestSuccess();
                this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    candidates: [{ content: { parts: [{ text: result.content }], role: 'model' }, finishReason: 'STOP' }],
                    usageMetadata: { promptTokenCount: result.usage.inputTokens, candidatesTokenCount: result.usage.outputTokens, totalTokenCount: result.usage.inputTokens + result.usage.outputTokens }
                }));
            }
        }
        catch (error) {
            this.handleApiError(res, account, error, '/v1beta', modelId, startTime, signal);
        }
    }
    // Model list cache
    modelCache = null;
    MODEL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
    // Steering File cache (from config.workspacePath load)
    steeringDocs = [];
    steeringPrompt = '';
    /** load/refresh steering File cache.config.workspacePath Called when changes occur. */
    loadSteering() {
        if (!this.config.workspacePath) {
            this.steeringDocs = [];
            this.steeringPrompt = '';
            return;
        }
        this.steeringDocs = (0, steeringLoader_1.loadSteeringDocuments)(this.config.workspacePath);
        this.steeringPrompt = (0, steeringLoader_1.formatSteeringForPrompt)(this.steeringDocs);
        if (this.steeringPrompt) {
            console.log(`[ProxyServer] Loaded ${this.steeringDocs.filter(d => d.inclusion === 'always').length} steering files from ${this.config.workspacePath}`);
        }
    }
    /** Get the formatted steering prompt(injected into system message Front) */
    getSteeringPrompt() {
        return this.steeringPrompt;
    }
    /** injection steering arrive OpenAI format requested messages（prepend arrive system Before the message or add system information) */
    injectSteeringOpenAI(messages) {
        if (!this.steeringPrompt)
            return messages;
        // Find the first one system news and prepend
        const sysIdx = messages.findIndex(m => m.role === 'system');
        if (sysIdx >= 0) {
            const sys = messages[sysIdx];
            const existingContent = typeof sys.content === 'string' ? sys.content : JSON.stringify(sys.content);
            return [
                ...messages.slice(0, sysIdx),
                { ...sys, content: `${this.steeringPrompt}\n\n${existingContent}` },
                ...messages.slice(sysIdx + 1)
            ];
        }
        // No system Message, add one at the beginning
        return [{ role: 'system', content: this.steeringPrompt }, ...messages];
    }
    /** injection steering arrive Claude format requested system Field */
    injectSteeringClaude(system) {
        if (!this.steeringPrompt)
            return system;
        if (!system)
            return this.steeringPrompt;
        if (typeof system === 'string')
            return `${this.steeringPrompt}\n\n${system}`;
        // system yes content block array,prepend one text block
        return [{ type: 'text', text: this.steeringPrompt }, ...system];
    }
    // Model list
    async handleModels(res, signal) {
        const now = Date.now();
        // Kiro official model (with UI be consistent)
        // Include thinking Supported default schema（output_config path)
        const kiroOfficialModels = [
            buildClientModel({ id: 'auto', created: now, ownedBy: 'kiro-api', description: 'Auto select best model' }),
            buildClientModel({
                id: 'claude-sonnet-4.5',
                created: now,
                ownedBy: 'kiro-api',
                description: 'The latest Claude Sonnet model',
                additionalModelRequestFieldsSchema: {
                    properties: {
                        thinking: { type: 'object' },
                        output_config: {
                            type: 'object',
                            properties: {
                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                            }
                        }
                    }
                }
            }),
            buildClientModel({
                id: 'claude-sonnet-4',
                created: now,
                ownedBy: 'kiro-api',
                description: 'Hybrid reasoning and coding',
                additionalModelRequestFieldsSchema: {
                    properties: {
                        thinking: { type: 'object' },
                        output_config: {
                            type: 'object',
                            properties: {
                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                            }
                        }
                    }
                }
            }),
            buildClientModel({ id: 'claude-haiku-4.5', created: now, ownedBy: 'kiro-api', description: 'The latest Claude Haiku model' }),
            buildClientModel({
                id: 'claude-opus-4.5',
                created: now,
                ownedBy: 'kiro-api',
                description: 'The most powerful model',
                additionalModelRequestFieldsSchema: {
                    properties: {
                        thinking: { type: 'object' },
                        output_config: {
                            type: 'object',
                            properties: {
                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                            }
                        }
                    }
                }
            })
        ];
        // Hidden model (not in official ListAvailableModels returned, but the backend may support it)
        const hiddenModels = [
            buildClientModel({ id: 'claude-3.7-sonnet', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (hidden)', modelName: 'Claude 3.7 Sonnet', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
            buildClientModel({ id: 'simple-task', created: now, ownedBy: 'kiro-api', description: 'Kiro fast model for intent classification and lightweight tasks (routes to Haiku)', modelName: 'Simple Task', supportedInputTypes: ['TEXT'], maxInputTokens: 200000, maxOutputTokens: 4096 }),
            buildClientModel({ id: 'CLAUDE_SONNET_4_20250514_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Sonnet 4 (CodeWhisperer internal ID)', modelName: 'Claude Sonnet 4 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
            buildClientModel({ id: 'CLAUDE_HAIKU_4_5_20251001_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Haiku 4.5 (CodeWhisperer internal ID)', modelName: 'Claude Haiku 4.5 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
            buildClientModel({ id: 'CLAUDE_3_7_SONNET_20250219_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (CodeWhisperer internal ID)', modelName: 'Claude 3.7 Sonnet (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 })
        ];
        // Default model (GPT Compatible with aliases)
        const presetModels = [
            buildClientModel({ id: 'gpt-4o', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
            buildClientModel({ id: 'gpt-4', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
            buildClientModel({ id: 'gpt-4-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
            buildClientModel({ id: 'gpt-3.5-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' })
        ];
        // try to start from Kiro API Get dynamic model
        let kiroModels = [];
        // Check cache
        if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
            kiroModels = this.modelCache.models;
        }
        else {
            // Get an available account to request a list of models
            const account = this.accountPool.getNextAccount();
            if (account) {
                try {
                    kiroModels = await (0, kiroApi_1.fetchKiroModels)(account, signal);
                    if (kiroModels.length > 0) {
                        // Build hardcoded model metadata for thinking support
                        const hardcodedThinkingModels = [
                            {
                                modelId: 'claude-sonnet-4.5',
                                modelName: 'Claude Sonnet 4.5',
                                description: 'The latest Claude Sonnet model',
                                supportedInputTypes: ['TEXT', 'IMAGE'],
                                tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
                                additionalModelRequestFieldsSchema: {
                                    properties: {
                                        thinking: { type: 'object' },
                                        output_config: {
                                            type: 'object',
                                            properties: {
                                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                modelId: 'claude-sonnet-4',
                                modelName: 'Claude Sonnet 4',
                                description: 'Hybrid reasoning and coding',
                                supportedInputTypes: ['TEXT', 'IMAGE'],
                                tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
                                additionalModelRequestFieldsSchema: {
                                    properties: {
                                        thinking: { type: 'object' },
                                        output_config: {
                                            type: 'object',
                                            properties: {
                                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                                            }
                                        }
                                    }
                                }
                            },
                            {
                                modelId: 'claude-opus-4.5',
                                modelName: 'Claude Opus 4.5',
                                description: 'The most powerful model',
                                supportedInputTypes: ['TEXT', 'IMAGE'],
                                tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
                                additionalModelRequestFieldsSchema: {
                                    properties: {
                                        thinking: { type: 'object' },
                                        output_config: {
                                            type: 'object',
                                            properties: {
                                                effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'] }
                                            }
                                        }
                                    }
                                }
                            }
                        ];
                        // Merge fetched models with hardcoded thinking models
                        // Strategy: Use API models as base, but if hardcoded model has thinking schema and API model doesn't, use hardcoded schema
                        const modelMap = new Map();
                        const hardcodedMap = new Map();
                        // Build hardcoded lookup
                        for (const m of hardcodedThinkingModels) {
                            hardcodedMap.set(m.modelId.toLowerCase(), m);
                        }
                        // Process API models: use API data but augment with hardcoded thinking schema if missing
                        for (const m of kiroModels) {
                            const lower = m.modelId.toLowerCase();
                            const hardcoded = hardcodedMap.get(lower);
                            // If API model has no thinking schema but hardcoded version does, use hardcoded schema
                            if (hardcoded && hardcoded.additionalModelRequestFieldsSchema && !m.additionalModelRequestFieldsSchema) {
                                modelMap.set(lower, {
                                    ...m,
                                    additionalModelRequestFieldsSchema: hardcoded.additionalModelRequestFieldsSchema
                                });
                            }
                            else {
                                modelMap.set(lower, m);
                            }
                        }
                        // Add hardcoded models that don't exist in API response
                        for (const m of hardcodedThinkingModels) {
                            const lower = m.modelId.toLowerCase();
                            if (!modelMap.has(lower)) {
                                modelMap.set(lower, m);
                            }
                        }
                        const mergedModels = Array.from(modelMap.values());
                        this.modelCache = { models: mergedModels, timestamp: now };
                        // Sync to kiroApi of ctx cache, for token Clipping logic usage
                        for (const m of mergedModels) {
                            if (m.tokenLimits?.maxInputTokens) {
                                (0, kiroApi_1.setModelContextWindow)(m.modelId, m.tokenLimits.maxInputTokens);
                            }
                        }
                        logger_1.proxyLogger.info('ProxyServer', `Fetched ${kiroModels.length} models from Kiro API, merged with ${hardcodedThinkingModels.length} hardcoded thinking models`);
                    }
                }
                catch (error) {
                    if (this.isAbortError(error, signal))
                        throw error;
                    console.error('[ProxyServer] Failed to fetch Kiro models:', error);
                }
            }
        }
        // Convert Kiro The model is OpenAI Format (keep original modelId）
        const dynamicModels = kiroModels.map(m => buildClientModel({
            id: m.modelId,
            created: now,
            ownedBy: 'kiro-api',
            description: m.description,
            modelName: m.modelName,
            supportedInputTypes: m.supportedInputTypes,
            maxInputTokens: m.tokenLimits?.maxInputTokens,
            maxOutputTokens: m.tokenLimits?.maxOutputTokens,
            rateMultiplier: m.rateMultiplier,
            rateUnit: m.rateUnit,
            promptCaching: m.promptCaching,
            additionalModelRequestFieldsSchema: m.additionalModelRequestFieldsSchema,
            modelProvider: m.modelProvider
        }));
        // Merge model lists and remove duplicates
        const modelIds = new Set();
        const allModels = [];
        // 1. Add dynamic models first (from API Obtained, including true token limit / input types）
        for (const m of dynamicModels) {
            if (!modelIds.has(m.id)) {
                modelIds.add(m.id);
                allModels.push(m);
            }
        }
        // 2. Added hidden model (not available in official ListAvailableModels returned, but the backend may support it)
        for (const m of hiddenModels) {
            if (!modelIds.has(m.id)) {
                modelIds.add(m.id);
                allModels.push(m);
            }
        }
        // 3. Only add static cover when the dynamic model is missing
        if (dynamicModels.length === 0) {
            for (const m of [...kiroOfficialModels, ...presetModels]) {
                if (!modelIds.has(m.id)) {
                    modelIds.add(m.id);
                    allModels.push(m);
                }
            }
        }
        this.throwIfResponseClosed(res, signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: allModels }));
    }
    // deal with OpenAI Chat Completions ask
    async handleOpenAIChat(req, res, signal) {
        const body = await this.readBody(req, signal);
        this.throwIfAborted(signal);
        const request = JSON.parse(body);
        const matchedApiKey = req.matchedApiKey;
        // extract session hint(for stable conversationId), spell in API Key hash Isolate different users
        const rawHintChat = ProxyServer.extractSessionHint(req, request);
        if (!request.conversation_id && rawHintChat) {
            const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default';
            request.conversation_id = `${keyPrefix}:${rawHintChat}`;
        }
        const affinityHintChat = request.conversation_id;
        // Apply model mapping
        request.model = this.applyModelMapping(request.model, matchedApiKey?.id);
        const startTime = Date.now();
        this.recordNewRequest();
        this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST' });
        let processedRequest;
        try {
            processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(request), signal);
        }
        catch (error) {
            if (this.isAbortError(error, signal))
                return;
            this.recordRequestFailed();
            const message = error instanceof Error ? error.message : 'Invalid request';
            this.sendError(res, 400, message);
            this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 400, error: message });
            this.recordRequest({ path: '/v1/chat/completions', model: request.model, responseTime: Date.now() - startTime, success: false, error: message });
            return;
        }
        // Get an account (including Token refresh check + session stickiness + API Key Account whitelist)
        this.throwIfAborted(signal);
        const account = await this.getAvailableAccount(signal, affinityHintChat, matchedApiKey?.id);
        this.throwIfAborted(signal);
        if (!account) {
            this.recordRequestFailed();
            const quotaStatus = this.accountPool.getQuotaStatus();
            const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
                ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
                : 'No available accounts';
            this.sendError(res, 503, errorMsg);
            this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 503, error: errorMsg });
            this.recordRequest({ path: '/v1/chat/completions', model: request.model, success: false, error: errorMsg });
            return;
        }
        this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: account.id });
        try {
            const toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry();
            // injection steering arrive system message
            if (this.steeringPrompt) {
                processedRequest.messages = this.injectSteeringOpenAI(processedRequest.messages);
            }
            // Make sure the model cache is loaded to support thinkingConfig Query
            await this.getAvailableModels(signal);
            // Convert to Kiro Format
            const thinkingConfig = this.getThinkingConfig(processedRequest.model);
            const kiroPayload = (0, translator_1.openaiToKiro)(processedRequest, account.profileArn, toolNameRegistry, thinkingConfig);
            // Record request details to log
            if (this.config.logRequests) {
                const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage;
                const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0;
                const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0;
                const historyLength = kiroPayload.conversationState.history?.length || 0;
                const hasImages = (userInput?.images?.length || 0) > 0;
                logger_1.proxyLogger.info('ProxyServer', `OpenAI API: ${request.model}`, {
                    model: request.model,
                    stream: request.stream,
                    contentLength,
                    toolsCount,
                    historyLength,
                    hasImages,
                    accountId: account.id
                });
            }
            if (request.stream) {
                // Streaming response (streaming does not use the retry mechanism, errors are handled by the stream)
                await this.handleOpenAIStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, matchedApiKey, toolNameRegistry, signal);
            }
            else {
                // Non-streaming response (with retry mechanism)
                const { result, account: usedAccount } = await this.callWithRetry(account, async (acc) => {
                    const retryPayload = (0, translator_1.openaiToKiro)(processedRequest, acc.profileArn, toolNameRegistry, thinkingConfig);
                    return (0, kiroApi_1.callKiroApi)(acc, retryPayload, signal);
                }, '/v1/chat/completions', signal);
                const response = (0, translator_1.kiroToOpenaiResponse)(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent);
                this.throwIfResponseClosed(res, signal);
                this.recordRequestSuccess();
                this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
                this.stats.inputTokens += result.usage.inputTokens;
                this.stats.outputTokens += result.usage.outputTokens;
                this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                const respTime = Date.now() - startTime;
                this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime });
                this.recordRequest({ path: '/v1/chat/completions', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true });
                // Record API Key Dosage
                if (matchedApiKey) {
                    this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, request.model, '/v1/chat/completions');
                }
            }
        }
        catch (error) {
            this.handleApiError(res, account, error, '/v1/chat/completions', request.model, startTime, signal);
        }
    }
    async handleOpenAIResponses(req, res, signal) {
        const body = await this.readBody(req, signal);
        this.throwIfAborted(signal);
        const matchedApiKey = req.matchedApiKey;
        const startTime = Date.now();
        this.recordNewRequest();
        this.events.onRequest?.({ path: '/v1/responses', method: 'POST' });
        let responseRequest;
        let chatRequest;
        let processedRequest;
        let affinityHintResp;
        try {
            responseRequest = JSON.parse(body);
            chatRequest = (0, translator_1.responsesToOpenAIChat)(responseRequest);
            // session hint: used for session stickiness
            const rawHintResp = ProxyServer.extractSessionHint(req, responseRequest);
            if (rawHintResp) {
                const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default';
                affinityHintResp = `${keyPrefix}:${rawHintResp}`;
            }
            chatRequest.model = this.applyModelMapping(chatRequest.model, matchedApiKey?.id);
            processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(chatRequest), signal);
        }
        catch (error) {
            if (this.isAbortError(error, signal))
                return;
            this.recordRequestFailed();
            const message = error instanceof Error ? error.message : 'Invalid request';
            this.sendError(res, 400, message);
            this.events.onResponse?.({ path: '/v1/responses', status: 400, error: message });
            this.recordRequest({ path: '/v1/responses', responseTime: Date.now() - startTime, success: false, error: message });
            return;
        }
        this.throwIfAborted(signal);
        const account = await this.getAvailableAccount(signal, affinityHintResp, matchedApiKey?.id);
        this.throwIfAborted(signal);
        if (!account) {
            this.recordRequestFailed();
            const quotaStatus = this.accountPool.getQuotaStatus();
            const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
                ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
                : 'No available accounts';
            this.sendError(res, 503, errorMsg);
            this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 503, error: errorMsg });
            this.recordRequest({ path: '/v1/responses', model: chatRequest.model, success: false, error: 'No available accounts' });
            return;
        }
        this.events.onRequest?.({ path: '/v1/responses', method: 'POST', accountId: account.id });
        try {
            const toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry();
            if (processedRequest.stream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });
                const responseId = `resp_${(0, uuid_1.v4)()}`;
                res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: chatRequest.model, output: [] } })}\n\n`);
                const { result, account: usedAccount } = await this.callWithRetry(account, async (acc) => {
                    const retryPayload = (0, translator_1.openaiToKiro)(processedRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(processedRequest.model));
                    return (0, kiroApi_1.callKiroApi)(acc, retryPayload, signal);
                }, '/v1/responses', signal);
                const chatResponse = (0, translator_1.kiroToOpenaiResponse)(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent);
                this.throwIfResponseClosed(res, signal);
                const response = (0, translator_1.openAIChatToResponsesResponse)(chatResponse, responseRequest.previous_response_id);
                const streamedResponse = { ...response, id: responseId };
                streamedResponse.output.forEach((item, outputIndex) => {
                    this.throwIfResponseClosed(res, signal);
                    res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item })}\n\n`);
                    if (item.type === 'message') {
                        item.content.forEach((part, contentIndex) => {
                            this.throwIfResponseClosed(res, signal);
                            res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { type: part.type, text: '' } })}\n\n`);
                            if (part.text) {
                                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text })}\n\n`);
                            }
                            res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text })}\n\n`);
                            res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part })}\n\n`);
                        });
                    }
                    else {
                        if (item.arguments) {
                            res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments })}\n\n`);
                        }
                        res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments })}\n\n`);
                    }
                    this.throwIfResponseClosed(res, signal);
                    res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })}\n\n`);
                });
                this.throwIfResponseClosed(res, signal);
                res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: streamedResponse })}\n\n`);
                res.end();
                this.recordRequestSuccess();
                this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
                this.stats.inputTokens += result.usage.inputTokens;
                this.stats.outputTokens += result.usage.outputTokens;
                this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens);
                const respTime = Date.now() - startTime;
                this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime });
                this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true });
                if (matchedApiKey) {
                    this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses');
                }
                return;
            }
            const { result, account: usedAccount } = await this.callWithRetry(account, async (acc) => {
                const retryPayload = (0, translator_1.openaiToKiro)(processedRequest, acc.profileArn, toolNameRegistry, this.getThinkingConfig(processedRequest.model));
                return (0, kiroApi_1.callKiroApi)(acc, retryPayload, signal);
            }, '/v1/responses', signal);
            const chatResponse = (0, translator_1.kiroToOpenaiResponse)(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent);
            this.throwIfResponseClosed(res, signal);
            const response = (0, translator_1.openAIChatToResponsesResponse)(chatResponse, responseRequest.previous_response_id);
            this.recordRequestSuccess();
            this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
            this.stats.inputTokens += result.usage.inputTokens;
            this.stats.outputTokens += result.usage.outputTokens;
            this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            const respTime = Date.now() - startTime;
            this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime });
            this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true });
            if (matchedApiKey) {
                this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses');
            }
        }
        catch (error) {
            this.handleApiError(res, account, error, '/v1/responses', chatRequest.model, startTime, signal);
        }
    }
    // deal with OpenAI Streaming response
    async handleOpenAIStream(res, account, kiroPayload, model, startTime, currentRound = 0, streamId, headersSent = false, matchedApiKey, toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry(), signal) {
        if (!headersSent) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
        }
        const id = streamId || `chatcmpl-${(0, uuid_1.v4)()}`;
        let toolCallIndex = 0;
        const pendingToolCalls = new Map();
        let collectedContent = '';
        // Send initial chunk(First round only)
        if (currentRound === 0) {
            const initialChunk = (0, translator_1.createOpenaiStreamChunk)(id, model, { role: 'assistant' });
            res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);
        }
        return new Promise((resolve) => {
            (0, kiroApi_1.callKiroApiStream)(account, kiroPayload, (text, toolUse, isThinking) => {
                if (signal?.aborted || this.isResponseClosed(res))
                    return;
                if (text && text.trim()) {
                    if (isThinking) {
                        // Native thinking content → The output is reasoning_content
                        const chunk = (0, translator_1.createOpenaiStreamChunk)(id, model, { reasoning_content: text });
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                    else {
                        // Normal text content
                        collectedContent += text;
                        const chunk = (0, translator_1.createOpenaiStreamChunk)(id, model, { content: text });
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    }
                }
                if (toolUse) {
                    const idx = toolCallIndex++;
                    const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse);
                    pendingToolCalls.set(toolUse.toolUseId, {
                        index: idx,
                        name: toolUse.name,
                        arguments: JSON.stringify(toolUse.input)
                    });
                    const toolChunk = (0, translator_1.createOpenaiStreamChunk)(id, model, {
                        tool_calls: [{
                                index: idx,
                                id: toolUse.toolUseId,
                                type: 'function',
                                function: {
                                    name: restoredToolUse.name,
                                    arguments: JSON.stringify(toolUse.input)
                                }
                            }]
                    });
                    res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
                }
                return this.waitForDrain(res);
            }, async (usage) => {
                if (signal?.aborted || this.isResponseClosed(res)) {
                    resolve();
                    return;
                }
                this.recordRequestSuccess();
                this.stats.totalTokens += usage.inputTokens + usage.outputTokens;
                this.stats.inputTokens += usage.inputTokens;
                this.stats.outputTokens += usage.outputTokens;
                this.stats.cacheReadTokens += usage.cacheReadTokens || 0;
                this.stats.cacheWriteTokens += usage.cacheWriteTokens || 0;
                this.stats.reasoningTokens += usage.reasoningTokens || 0;
                this.stats.totalCredits += usage.credits || 0;
                this.events.onCreditsUpdate?.(this.stats.totalCredits);
                this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens);
                this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens);
                const oaiRespTime = Date.now() - startTime;
                this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: oaiRespTime });
                this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: oaiRespTime, success: true });
                // Record API Key Dosage
                if (matchedApiKey) {
                    this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/chat/completions');
                }
                // End of sending chunk(Includes complete usage information)
                const hasToolCalls = pendingToolCalls.size > 0;
                const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
                const usageInfo = {
                    prompt_tokens: usage.inputTokens,
                    completion_tokens: usage.outputTokens,
                    total_tokens: usage.inputTokens + usage.outputTokens
                };
                // Add to cache tokens Details
                if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
                    usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens };
                }
                // Add to reasoning tokens Details
                if (usage.reasoningTokens && usage.reasoningTokens > 0) {
                    usageInfo.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens };
                }
                const finalChunk = (0, translator_1.createOpenaiStreamChunk)(id, model, {}, finishReason, usageInfo);
                res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                resolve();
            }, (error) => {
                if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                    resolve();
                    return;
                }
                console.error('[ProxyServer] Stream error:', error);
                res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                res.end();
                this.recordRequestFailed();
                const errStatusCode = error.message.match(/(\d{3})/)?.[1];
                this.accountPool.recordError(account.id, errStatusCode ? (0, accountPool_1.classifyError)(parseInt(errStatusCode)) : accountPool_1.ErrorType.RECOVERABLE, errStatusCode ? parseInt(errStatusCode) : undefined);
                this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 500, error: error.message });
                this.recordRequest({ path: '/v1/chat/completions', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message });
                resolve();
            }, signal, this.config.preferredEndpoint).catch(error => {
                if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
                    res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`);
                    res.end();
                    this.recordRequestFailed();
                }
                resolve();
            });
        });
    }
    // deal with Claude Messages ask
    async handleClaudeMessages(req, res, signal) {
        const body = await this.readBody(req, signal);
        this.throwIfAborted(signal);
        const request = JSON.parse(body);
        const matchedApiKey = req.matchedApiKey;
        // extract session hint(for stable conversationId), spell in API Key hash Isolate different users
        const rawHint = ProxyServer.extractSessionHint(req, request);
        if (!request.conversation_id && rawHint) {
            const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default';
            request.conversation_id = `${keyPrefix}:${rawHint}`;
        }
        // P1-8 session stickiness usage conversation_id as sticky key(included API Key prefix)
        const affinityHint = request.conversation_id;
        // Apply model mapping
        request.model = this.applyModelMapping(request.model, matchedApiKey?.id);
        const startTime = Date.now();
        this.recordNewRequest();
        this.events.onRequest?.({ path: '/v1/messages', method: 'POST' });
        let processedRequest;
        try {
            processedRequest = await this.resolveClaudeHttpImages(this.prepareClaudeRequest(request), signal);
        }
        catch (error) {
            if (this.isAbortError(error, signal))
                return;
            this.recordRequestFailed();
            const message = error instanceof Error ? error.message : 'Invalid request';
            this.sendError(res, 400, message, 'anthropic');
            this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 400, error: message });
            this.recordRequest({ path: '/v1/messages', model: request.model, responseTime: Date.now() - startTime, success: false, error: message });
            return;
        }
        // Get an account (including Token refresh check + session stickiness + API Key Account whitelist)
        this.throwIfAborted(signal);
        const account = await this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id);
        this.throwIfAborted(signal);
        if (!account) {
            this.recordRequestFailed();
            const quotaStatus = this.accountPool.getQuotaStatus();
            const errorMsg = quotaStatus.exhausted > 0 && quotaStatus.available === 0
                ? `All accounts quota exhausted (${quotaStatus.exhausted}/${quotaStatus.total} exhausted, ${quotaStatus.cooldown} in cooldown)`
                : 'No available accounts';
            this.sendError(res, 503, errorMsg, 'anthropic');
            this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 503, error: errorMsg });
            this.recordRequest({ path: '/v1/messages', model: request.model, success: false, error: errorMsg });
            return;
        }
        this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: account.id });
        try {
            const toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry();
            // injection steering arrive Claude system
            if (this.steeringPrompt) {
                processedRequest.system = this.injectSteeringClaude(processedRequest.system);
            }
            // Make sure the model cache is loaded to support thinkingConfig Query
            await this.getAvailableModels(signal);
            const claudeThinkingConfig = this.getThinkingConfig(processedRequest.model);
            const kiroPayload = (0, translator_1.claudeToKiro)(processedRequest, account.profileArn, toolNameRegistry, claudeThinkingConfig);
            // Build prompt cache profile(for simulating caching usage）
            const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length * 0.3));
            const cacheProfile = promptCacheTracker_1.promptCacheTracker.buildClaudeProfile(processedRequest.system, processedRequest.messages, processedRequest.tools, estimatedInputTokens, processedRequest.model);
            const cacheUsage = promptCacheTracker_1.promptCacheTracker.compute(account.id, cacheProfile);
            if (cacheProfile) {
                logger_1.proxyLogger.info('ProxyServer', `Prompt cache: ${cacheProfile.breakpoints.length} breakpoints, creation=${cacheUsage.cacheCreationInputTokens}, read=${cacheUsage.cacheReadInputTokens}`);
            }
            // Record request details to log
            if (this.config.logRequests) {
                const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage;
                const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0;
                const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0;
                const historyLength = kiroPayload.conversationState.history?.length || 0;
                const hasImages = (userInput?.images?.length || 0) > 0;
                logger_1.proxyLogger.info('ProxyServer', `Claude API: ${request.model}`, {
                    model: request.model,
                    stream: request.stream,
                    contentLength,
                    toolsCount,
                    historyLength,
                    hasImages,
                    accountId: account.id.substring(0, 8) + '...'
                });
            }
            if (request.stream) {
                // Streaming response (streaming does not use the retry mechanism, errors are handled by the stream)
                await this.handleClaudeStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, 0, matchedApiKey, toolNameRegistry, signal, cacheProfile ? { ...cacheUsage, cacheProfile, accountId: account.id } : undefined);
            }
            else {
                // Non-streaming response (with retry mechanism)
                const { result, account: usedAccount } = await this.callWithRetry(account, async (acc) => {
                    const retryPayload = (0, translator_1.claudeToKiro)(processedRequest, acc.profileArn, toolNameRegistry, claudeThinkingConfig);
                    return (0, kiroApi_1.callKiroApi)(acc, retryPayload, signal);
                }, '/v1/messages', signal);
                const response = (0, translator_1.kiroToClaudeResponse)(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent);
                // simulated with cache usage override (if any cache profile）
                if (cacheProfile && cacheUsage) {
                    if (cacheUsage.cacheCreationInputTokens > 0)
                        response.usage.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens;
                    if (cacheUsage.cacheReadInputTokens > 0)
                        response.usage.cache_read_input_tokens = cacheUsage.cacheReadInputTokens;
                    promptCacheTracker_1.promptCacheTracker.update(usedAccount.id, cacheProfile);
                }
                this.throwIfResponseClosed(res, signal);
                this.recordRequestSuccess();
                this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens;
                this.stats.inputTokens += result.usage.inputTokens;
                this.stats.outputTokens += result.usage.outputTokens;
                this.accountPool.recordSuccess(usedAccount.id, result.usage.inputTokens + result.usage.outputTokens);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
                const respTime = Date.now() - startTime;
                this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime });
                this.recordRequest({ path: '/v1/messages', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true });
            }
        }
        catch (error) {
            this.handleApiError(res, account, error, '/v1/messages', request.model, startTime, signal);
        }
    }
    // deal with Claude Streaming response
    async handleClaudeStream(res, account, kiroPayload, model, startTime, currentRound = 0, msgId, headersSent = false, contentBlockIndex = 0, matchedApiKey, toolNameRegistry = new toolNameRegistry_1.ToolNameRegistry(), signal, simulatedCacheUsage) {
        if (!headersSent) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
            });
        }
        const id = msgId || `msg_${(0, uuid_1.v4)()}`;
        let currentBlockIndex = contentBlockIndex;
        let hasStartedTextBlock = false;
        let hasStartedThinkingBlock = false;
        let pendingThinkingSignature;
        let collectedContent = '';
        const pendingToolCalls = new Map();
        const flushThinkingSignature = () => {
            if (!pendingThinkingSignature)
                return;
            const signatureDelta = (0, translator_1.createClaudeStreamEvent)('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'signature_delta', signature: pendingThinkingSignature }
            });
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(signatureDelta)}\n\n`);
            pendingThinkingSignature = undefined;
        };
        // Estimate input tokens(based on payload size)
        const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length / 3));
        // send message_start(First round only)
        if (currentRound === 0) {
            const messageStart = (0, translator_1.createClaudeStreamEvent)('message_start', {
                message: {
                    id,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model,
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: estimatedInputTokens, output_tokens: 0 }
                }
            });
            res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
        }
        return new Promise((resolve) => {
            (0, kiroApi_1.callKiroApiStream)(account, kiroPayload, (text, toolUse, isThinking, reasoningSignature, redactedContent) => {
                if (signal?.aborted || this.isResponseClosed(res))
                    return;
                // Prioritize processing redacted_thinking(encrypted thinking block, need to be separate content_block）
                if (redactedContent) {
                    if (hasStartedTextBlock) {
                        const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                        currentBlockIndex++;
                        hasStartedTextBlock = false;
                    }
                    if (hasStartedThinkingBlock) {
                        flushThinkingSignature();
                        const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                        currentBlockIndex++;
                        hasStartedThinkingBlock = false;
                    }
                    const blockStart = (0, translator_1.createClaudeStreamEvent)('content_block_start', {
                        index: currentBlockIndex,
                        content_block: { type: 'redacted_thinking', data: redactedContent }
                    });
                    res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                    const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                    currentBlockIndex++;
                    return this.waitForDrain(res);
                }
                if (text && text.trim()) {
                    if (isThinking) {
                        // Native thinking content → The output is Anthropic thinking block
                        if (hasStartedTextBlock) {
                            const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                            currentBlockIndex++;
                            hasStartedTextBlock = false;
                        }
                        if (!hasStartedThinkingBlock) {
                            const blockStart = (0, translator_1.createClaudeStreamEvent)('content_block_start', {
                                index: currentBlockIndex,
                                content_block: { type: 'thinking', thinking: '' }
                            });
                            res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                            hasStartedThinkingBlock = true;
                        }
                        const delta = (0, translator_1.createClaudeStreamEvent)('content_block_delta', {
                            index: currentBlockIndex,
                            delta: { type: 'thinking_delta', thinking: text }
                        });
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`);
                        if (reasoningSignature) {
                            pendingThinkingSignature = reasoningSignature;
                        }
                    }
                    else {
                        // Normal text content
                        if (hasStartedThinkingBlock) {
                            flushThinkingSignature();
                            const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                            currentBlockIndex++;
                            hasStartedThinkingBlock = false;
                        }
                        collectedContent += text;
                        if (!hasStartedTextBlock) {
                            const blockStart = (0, translator_1.createClaudeStreamEvent)('content_block_start', {
                                index: currentBlockIndex,
                                content_block: { type: 'text', text: '' }
                            });
                            res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                            hasStartedTextBlock = true;
                        }
                        const delta = (0, translator_1.createClaudeStreamEvent)('content_block_delta', {
                            index: currentBlockIndex,
                            delta: { type: 'text_delta', text }
                        });
                        res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`);
                    }
                }
                else if (isThinking && reasoningSignature) {
                    if (!hasStartedThinkingBlock) {
                        const blockStart = (0, translator_1.createClaudeStreamEvent)('content_block_start', {
                            index: currentBlockIndex,
                            content_block: { type: 'thinking', thinking: '' }
                        });
                        res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`);
                        hasStartedThinkingBlock = true;
                    }
                    pendingThinkingSignature = reasoningSignature;
                }
                if (toolUse) {
                    const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse);
                    if (hasStartedThinkingBlock) {
                        flushThinkingSignature();
                        const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                        currentBlockIndex++;
                        hasStartedThinkingBlock = false;
                    }
                    // text block before end
                    if (hasStartedTextBlock) {
                        const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                        res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                        currentBlockIndex++;
                        hasStartedTextBlock = false;
                    }
                    // Logging tool calls
                    pendingToolCalls.set(toolUse.toolUseId, { name: toolUse.name, input: toolUse.input });
                    // Start tool block
                    const toolBlockStart = (0, translator_1.createClaudeStreamEvent)('content_block_start', {
                        index: currentBlockIndex,
                        content_block: { type: 'tool_use', id: toolUse.toolUseId, name: restoredToolUse.name, input: {} }
                    });
                    res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`);
                    // Send tool input
                    const toolDelta = (0, translator_1.createClaudeStreamEvent)('content_block_delta', {
                        index: currentBlockIndex,
                        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) }
                    });
                    res.write(`event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`);
                    // end tool block
                    const toolBlockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`);
                    currentBlockIndex++;
                }
                return this.waitForDrain(res);
            }, async (usage) => {
                if (signal?.aborted || this.isResponseClosed(res)) {
                    resolve();
                    return;
                }
                if (hasStartedThinkingBlock) {
                    flushThinkingSignature();
                    const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                    currentBlockIndex++;
                    hasStartedThinkingBlock = false;
                }
                // End last block of text
                if (hasStartedTextBlock) {
                    const blockStop = (0, translator_1.createClaudeStreamEvent)('content_block_stop', { index: currentBlockIndex });
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`);
                    currentBlockIndex++;
                }
                this.recordRequestSuccess();
                this.stats.totalTokens += usage.inputTokens + usage.outputTokens;
                this.stats.inputTokens += usage.inputTokens;
                this.stats.outputTokens += usage.outputTokens;
                this.stats.totalCredits += usage.credits || 0;
                this.events.onCreditsUpdate?.(this.stats.totalCredits);
                this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens);
                this.accountPool.recordSuccess(account.id, usage.inputTokens + usage.outputTokens);
                this.stats.cacheReadTokens += usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens || 0;
                this.stats.cacheWriteTokens += usage.cacheWriteTokens || simulatedCacheUsage?.cacheCreationInputTokens || 0;
                this.stats.reasoningTokens += usage.reasoningTokens || 0;
                const respTime = Date.now() - startTime;
                this.events.onResponse?.({ path: '/v1/messages', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: respTime });
                this.recordRequest({ path: '/v1/messages', model, accountId: account.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: respTime, success: true });
                // Record API Key Dosage
                if (matchedApiKey) {
                    this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/messages');
                }
                // Update after success prompt cache tracker
                if (simulatedCacheUsage?.cacheProfile && simulatedCacheUsage?.accountId) {
                    promptCacheTracker_1.promptCacheTracker.update(simulatedCacheUsage.accountId, simulatedCacheUsage.cacheProfile);
                }
                // send message_delta(Includes complete usage information)
                const hasToolCalls = pendingToolCalls.size > 0;
                const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';
                const messageDelta = (0, translator_1.createClaudeStreamEvent)('message_delta', {
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: this.buildClaudeUsage(usage, simulatedCacheUsage)
                });
                res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);
                // send message_stop
                const messageStop = (0, translator_1.createClaudeStreamEvent)('message_stop');
                res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`);
                res.end();
                resolve();
            }, (error) => {
                if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                    resolve();
                    return;
                }
                console.error('[ProxyServer] Stream error:', error);
                const errorEvent = (0, translator_1.createClaudeStreamEvent)('error', {
                    error: { type: 'api_error', message: error.message }
                });
                res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                res.end();
                this.recordRequestFailed();
                const errStatusCode2 = error.message.match(/(\d{3})/)?.[1];
                this.accountPool.recordError(account.id, errStatusCode2 ? (0, accountPool_1.classifyError)(parseInt(errStatusCode2)) : accountPool_1.ErrorType.RECOVERABLE, errStatusCode2 ? parseInt(errStatusCode2) : undefined);
                this.events.onResponse?.({ path: '/v1/messages', model, status: 500, error: error.message });
                this.recordRequest({ path: '/v1/messages', model, accountId: account.id, responseTime: Date.now() - startTime, success: false, error: error.message });
                resolve();
            }, signal, this.config.preferredEndpoint).catch(error => {
                if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
                    const errorEvent = (0, translator_1.createClaudeStreamEvent)('error', {
                        error: { type: 'api_error', message: error.message }
                    });
                    res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
                    res.end();
                    this.recordRequestFailed();
                }
                resolve();
            });
        });
    }
    // deal with API mistake
    handleApiError(res, account, error, path, model, startTime, signal) {
        if (this.isAbortError(error, signal) || this.isResponseClosed(res))
            return;
        this.recordRequestFailed();
        const errCode = error.message.match(/(\d{3})/)?.[1];
        const parsedCode = errCode ? parseInt(errCode) : 500;
        const errorType = (0, accountPool_1.classifyError)(parsedCode);
        const isAuthError = error.message.includes('401') || error.message.includes('403') || error.message.includes('Auth');
        this.accountPool.recordError(account.id, errorType, parsedCode);
        let statusCode = parsedCode;
        if (isAuthError)
            statusCode = 401;
        if (res.headersSent) {
            if (!this.isResponseClosed(res)) {
                if (path === '/v1/responses' || path === '/responses') {
                    res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', error: { type: 'api_error', message: error.message } })}\n\n`);
                }
                res.end();
            }
            this.events.onResponse?.({ path, status: statusCode, error: error.message });
            this.recordRequest({ path, model, accountId: account.id, responseTime: startTime ? Date.now() - startTime : 0, success: false, error: error.message });
            return;
        }
        this.sendError(res, statusCode, error.message, this.isAnthropicPath(path) ? 'anthropic' : 'openai');
        this.events.onResponse?.({ path, status: statusCode, error: error.message });
        this.recordRequest({ path, model, accountId: account.id, responseTime: startTime ? Date.now() - startTime : 0, success: false, error: error.message });
    }
    // Read request body
    /**
     * Read the request body, limiting the maximum number of bytes to prevent DoS
     * - Content-Length Head over limit: Immediately reject
     * - Streaming accumulation exceeds limit: destroy the connection and reject
     * trigger BodyTooLarge When an error occurs, the upper layer will send 413 Payload Too Large
     */
    readBody(req, signal) {
        const maxBytes = Math.max(1024, this.config.maxRequestBodyBytes ?? 10 * 1024 * 1024);
        // priority Content-Length Early rejection (avoid buffer allocation)
        const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
        if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
            return Promise.reject(new BodyTooLargeError(declaredLen, maxBytes));
        }
        return new Promise((resolve, reject) => {
            const chunks = [];
            let total = 0;
            const cleanup = () => {
                req.off('data', onData);
                req.off('end', onEnd);
                req.off('error', onError);
                req.off('aborted', onAborted);
                signal?.removeEventListener('abort', onAbort);
            };
            const onData = (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    cleanup();
                    try {
                        req.destroy();
                    }
                    catch { /* ignore */ }
                    reject(new BodyTooLargeError(total, maxBytes));
                    return;
                }
                chunks.push(chunk);
            };
            const onEnd = () => {
                cleanup();
                resolve(Buffer.concat(chunks, total).toString('utf8'));
            };
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onAborted = () => {
                cleanup();
                reject(new Error('Client disconnected'));
            };
            const onAbort = () => {
                cleanup();
                reject(this.getAbortError(signal));
            };
            if (signal?.aborted) {
                reject(this.getAbortError(signal));
                return;
            }
            req.on('data', onData);
            req.on('end', onEnd);
            req.on('error', onError);
            req.on('aborted', onAborted);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }
    // Send error response
    // P0-5 automatic sanitize：500 Not vomiting message details;4xx Client error returns normally
    sendError(res, status, message, format = 'openai') {
        if (res.writableEnded || res.destroyed)
            return;
        // 500-599 Enforce the use of common messages (prevent leakage of internal information)
        const safeMessage = status >= 500 && status < 600
            ? this.sanitizeErrorMessage(message) || 'Internal server error'
            : message;
        // P1-6 503 → trigger webhook(Already have 5 minutes to remove duplicates)
        if (status === 503) {
            this.notifyAllAccountsExhausted('unknown');
        }
        res.writeHead(status, { 'Content-Type': 'application/json' });
        if (format === 'anthropic') {
            res.end(JSON.stringify({
                type: 'error',
                error: {
                    type: this.getAnthropicErrorType(status),
                    message: safeMessage
                }
            }));
            return;
        }
        res.end(JSON.stringify({ error: { message: safeMessage, type: 'error', code: status } }));
    }
    /**
     * P0-5 / P2-19 Error message desensitization (removal of possible Bearer/Token/Sensitive information such as paths)
     * for error responses and log output
     */
    sanitizeErrorMessage(msg) {
        if (!msg)
            return '';
        return msg
            // Bearer xxxx → Bearer ***
            .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer ***')
            // access_token / refresh_token / api_key / x-api-key field value
            .replace(/(access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key)["'\s:=]+[^"',\s}]+/gi, '$1=***')
            // long base64/JWT（>= 40 chars) replaced by placeholder
            .replace(/eyJ[A-Za-z0-9\-_]{20,}/g, 'eyJ***')
            // Windows User path
            .replace(/C:\\Users\\[^\\/\s]+/gi, 'C:\\Users\\***')
            // Linux/Mac home path
            .replace(/\/home\/[^\s/]+/g, '/home/***')
            .replace(/\/Users\/[^\s/]+/g, '/Users/***');
    }
    /**
     * P1-7 Sliding window current limit: every minute N times (press API Key id or IP）
     * 0 = no limit
     */
    checkRateLimit(id) {
        const limit = this.config.rateLimitPerKeyPerMinute || 0;
        if (limit <= 0)
            return { allowed: true, retryAfterMs: 0 };
        const now = Date.now();
        const bucket = this.rateLimitBuckets.get(id);
        if (!bucket || now - bucket.windowStart >= 60_000) {
            this.rateLimitBuckets.set(id, { count: 1, windowStart: now });
            return { allowed: true, retryAfterMs: 0 };
        }
        if (bucket.count >= limit) {
            return { allowed: false, retryAfterMs: 60_000 - (now - bucket.windowStart) };
        }
        bucket.count++;
        return { allowed: true, retryAfterMs: 0 };
    }
    /** Clean expired current-limiting buckets regularly / Session sticky entries (to avoid memory leaks) */
    cleanupExpiredCaches() {
        const now = Date.now();
        // Current limiting bucket expires 2 minute
        for (const [key, bucket] of this.rateLimitBuckets) {
            if (now - bucket.windowStart > 120_000)
                this.rateLimitBuckets.delete(key);
        }
        // Sticky session expired 10 minute
        for (const [key, entry] of this.sessionAffinity) {
            if (now - entry.lastAt > 600_000)
                this.sessionAffinity.delete(key);
        }
        // Most audit logs 200 strip
        if (this.auditLog.length > 200) {
            this.auditLog = this.auditLog.slice(-200);
        }
    }
    /**
     * P1-8 Session Sticky Account Selection: Same session hint Prioritize reusing the same account
     * Implementation method: use sessionHint hash Indexed to a fixed account; stickiness will automatically expire when the account expires
     */
    pickAccountWithAffinity(sessionHint) {
        if (!this.config.sessionAffinityEnabled || !sessionHint)
            return null;
        const entry = this.sessionAffinity.get(sessionHint);
        if (entry) {
            const account = this.accountPool.getAccount(entry.accountId);
            // Verify that the account is still available and has not been banned
            if (account && !this.accountPool.isSuspended(account) && account.isAvailable !== false) {
                entry.lastAt = Date.now();
                return account;
            }
            // Expired → Clean off the stickiness
            this.sessionAffinity.delete(sessionHint);
        }
        return null;
    }
    /** Record sticky mapping */
    rememberAffinity(sessionHint, accountId) {
        if (!this.config.sessionAffinityEnabled || !sessionHint)
            return;
        this.sessionAffinity.set(sessionHint, { accountId, lastAt: Date.now() });
    }
    /** P2-17 Audit log */
    appendAuditLog(type, data) {
        if (!this.config.enableAuditLog)
            return;
        this.auditLog.push({ ts: Date.now(), type, data });
        if (this.auditLog.length > 200)
            this.auditLog.shift();
    }
    /** Get audit logs (for management API） */
    getAuditLog() {
        return this.auditLog;
    }
    /** injection webhook trigger (consisting of main/index.ts inject, call renderer of webhook store） */
    setWebhookTrigger(fn) {
        this.webhookTrigger = fn;
    }
    /** Key event deduplication timestamp (5 The same event will not be pushed repeatedly within minutes) */
    lastWebhookByEvent = new Map();
    /** P1-6 trigger webhook(Encapsulation error handling + 5 minutes to remove duplicates) */
    triggerWebhook(event, payload) {
        const now = Date.now();
        const last = this.lastWebhookByEvent.get(event) || 0;
        if (now - last < 5 * 60_000)
            return; // Same event 5 Do not push again within minutes
        this.lastWebhookByEvent.set(event, now);
        try {
            this.webhookTrigger?.(event, payload);
        }
        catch (err) {
            logger_1.proxyLogger.warn('ProxyServer', `Webhook trigger failed: ${err.message}`);
        }
    }
    /** All quotas exhausted webhook（503 called when) */
    notifyAllAccountsExhausted(path, model) {
        const quota = this.accountPool.getQuotaStatus();
        this.appendAuditLog('all_accounts_exhausted', { path, model, ...quota });
        this.triggerWebhook('proxy-all-exhausted', {
            title: 'All anti-generation accounts are unavailable',
            message: `All account quotas are exhausted or on cooling (exhausted=${quota.exhausted}/${quota.total}，cooldown=${quota.cooldown}）`,
            level: 'error',
            fields: { endpoint: path, Model: model || '-', 'total account': quota.total, 'quota exhausted': quota.exhausted, 'Cooling down': quota.cooldown, Available: quota.available }
        });
    }
    /** P2-16 Prometheus metrics text */
    renderPrometheusMetrics() {
        const s = this.stats;
        const ap = this.accountPool;
        const lines = [];
        lines.push('# HELP kiro_proxy_requests_total Total requests handled');
        lines.push('# TYPE kiro_proxy_requests_total counter');
        lines.push(`kiro_proxy_requests_total ${s.totalRequests}`);
        lines.push('# HELP kiro_proxy_requests_success_total Total successful requests');
        lines.push('# TYPE kiro_proxy_requests_success_total counter');
        lines.push(`kiro_proxy_requests_success_total ${s.successRequests}`);
        lines.push('# HELP kiro_proxy_requests_failed_total Total failed requests');
        lines.push('# TYPE kiro_proxy_requests_failed_total counter');
        lines.push(`kiro_proxy_requests_failed_total ${s.failedRequests}`);
        lines.push('# HELP kiro_proxy_tokens_total Total tokens consumed');
        lines.push('# TYPE kiro_proxy_tokens_total counter');
        lines.push(`kiro_proxy_tokens_total{type="input"} ${s.inputTokens}`);
        lines.push(`kiro_proxy_tokens_total{type="output"} ${s.outputTokens}`);
        lines.push(`kiro_proxy_tokens_total{type="cache_read"} ${s.cacheReadTokens}`);
        lines.push(`kiro_proxy_tokens_total{type="cache_write"} ${s.cacheWriteTokens}`);
        lines.push('# HELP kiro_proxy_credits_total Total credits consumed');
        lines.push('# TYPE kiro_proxy_credits_total counter');
        lines.push(`kiro_proxy_credits_total ${s.totalCredits}`);
        lines.push('# HELP kiro_proxy_accounts Accounts by status');
        lines.push('# TYPE kiro_proxy_accounts gauge');
        const quota = ap.getQuotaStatus();
        lines.push(`kiro_proxy_accounts{status="total"} ${quota.total}`);
        lines.push(`kiro_proxy_accounts{status="available"} ${quota.available}`);
        lines.push(`kiro_proxy_accounts{status="exhausted"} ${quota.exhausted}`);
        lines.push(`kiro_proxy_accounts{status="cooldown"} ${quota.cooldown}`);
        lines.push('# HELP kiro_proxy_uptime_seconds Server uptime in seconds');
        lines.push('# TYPE kiro_proxy_uptime_seconds gauge');
        lines.push(`kiro_proxy_uptime_seconds ${Math.floor((Date.now() - s.startTime) / 1000)}`);
        return lines.join('\n') + '\n';
    }
    // record request to recentRequests
    recordRequest(log) {
        this.stats.recentRequests.push({
            timestamp: Date.now(),
            path: log.path,
            model: log.model || 'unknown',
            accountId: log.accountId || 'unknown',
            inputTokens: log.inputTokens || 0,
            outputTokens: log.outputTokens || 0,
            credits: log.credits,
            responseTime: log.responseTime || 0,
            success: log.success,
            // P2-19 Error message desensitization
            error: log.error ? this.sanitizeErrorMessage(log.error).slice(0, 500) : undefined
        });
        // P2-15 Configurable upper limit (default 100,most 10000）
        const limit = Math.min(10000, Math.max(20, this.config.recentRequestsLimit || 100));
        if (this.stats.recentRequests.length > limit) {
            this.stats.recentRequests = this.stats.recentRequests.slice(-limit);
        }
    }
}
exports.ProxyServer = ProxyServer;
