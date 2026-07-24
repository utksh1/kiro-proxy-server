"use strict";
// Kiro IDE Auth Token synchronization layer
//
// Kiro IDE desktop handle token persist in ~/.aws/sso/cache/kiro-auth-token.json，
// and do this to the file fs.watchFile monitor + internal refresh loop。
//
// anti-generational IDE This file must be used as single source of truth, otherwise it will appear:
//   Anti-generational store inside refreshToken_v2, in the disk refreshToken_v1(has been invalidated by server rotation)
//   → IDE Use after one hour v1 tune OIDC → 401 → logoutAndForget()
//
// This module provides:
//   writeKiroAuthTokenFile  — by Kiro IDE Compatible format writing token document(+ IdC Client registration)
//   readKiroAuthTokenFile   — Read current disk token
//   parseAccessTokenClaims  — untie accessToken of JWT get sub/email, used to reverse account matching
//   watchKiroAuthTokenFile  — Monitor file changes (IDE Own refresh When used to reverse synchronize to the reverse generation store）
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.KIRO_SOCIAL_PROFILE_ARN = exports.KIRO_BUILDER_ID_PLACEHOLDER_ARN = exports.KIRO_AUTH_TOKEN_PATH = exports.KIRO_SSO_CACHE_DIR = void 0;
exports.getEnterpriseFallbackArn = getEnterpriseFallbackArn;
exports.isPlaceholderProfileArn = isPlaceholderProfileArn;
exports.resolveProfileArnForWrite = resolveProfileArnForWrite;
exports.writeKiroAuthTokenFile = writeKiroAuthTokenFile;
exports.readKiroAuthTokenFile = readKiroAuthTokenFile;
exports.parseAccessTokenClaims = parseAccessTokenClaims;
exports.watchKiroAuthTokenFile = watchKiroAuthTokenFile;
const fs = __importStar(require("fs/promises"));
const fsSync = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
exports.KIRO_SSO_CACHE_DIR = path.join(os.homedir(), '.aws', 'sso', 'cache');
exports.KIRO_AUTH_TOKEN_PATH = path.join(exports.KIRO_SSO_CACHE_DIR, 'kiro-auth-token.json');
const KIRO_DEFAULT_START_URL = 'https://view.awsapps.com/start';
const KIRO_OIDC_SCOPES = [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
];
// =============== profileArn decision center ===============
//
// placeholder ARN：Kiro IDE Source code FixedProfileArns Li give BuilderId Hardcoded value.
// Kiro IDE Internal logic relies on the existence of this field, and removing it will result in IDE Abnormal function.
exports.KIRO_BUILDER_ID_PLACEHOLDER_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX';
// Social Log in(Github/Google) shared Kiro backend fixed profileArn
exports.KIRO_SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK';
// Enterprise spare profileArn(Used when automatic acquisition fails, the area is dynamically replaced)
const ENTERPRISE_FALLBACK_PROFILE_ID = 'VNECVYCYYAWN';
const ENTERPRISE_FALLBACK_ACCOUNT_ID = '610548660232';
function getEnterpriseFallbackArn(region) {
    const r = region?.startsWith('eu-') ? 'eu-central-1' : 'us-east-1';
    return `arn:aws:codewhisperer:${r}:${ENTERPRISE_FALLBACK_ACCOUNT_ID}:profile/${ENTERPRISE_FALLBACK_PROFILE_ID}`;
}
const PLACEHOLDER_PROFILE_ARNS = new Set([exports.KIRO_BUILDER_ID_PLACEHOLDER_ARN]);
/** Check given ARN Is it a known placeholder (old version anti-generation / Kiro IDE Dirty data that may be written by itself) */
function isPlaceholderProfileArn(arn) {
    if (!arn)
        return false;
    return PLACEHOLDER_PROFILE_ARNS.has(arn);
}
/**
 * write token file before profileArn of"What should I write?"Make unified decisions.
 *
 * Rules (priority):
 *   1. Explicitly given by the caller profileArn and not a known placeholder → Use directly
 *   2. social/Github/Google → Use fixed Kiro Social profileArn
 *   3. BuilderId / other → use Kiro IDE official placeholder ARN（IDE Internal logic relies on the existence of this field)
 */
function resolveProfileArnForWrite(input) {
    if (input.profileArn && !isPlaceholderProfileArn(input.profileArn)) {
        return input.profileArn;
    }
    if (input.authMethod === 'social' || input.provider === 'Github' || input.provider === 'Google') {
        return exports.KIRO_SOCIAL_PROFILE_ARN;
    }
    // Enterprise The ____ does not work BuilderId placeholder (IDE Debug interface Invalid token）
    if (input.provider === 'Enterprise' || input.authMethod === 'external_idp') {
        return getEnterpriseFallbackArn(input.region);
    }
    return exports.KIRO_BUILDER_ID_PLACEHOLDER_ARN;
}
function computeClientIdHash(startUrl) {
    return crypto
        .createHash('sha1')
        .update(JSON.stringify({ startUrl: startUrl || KIRO_DEFAULT_START_URL }))
        .digest('hex');
}
/**
 * with Kiro IDE Fully compatible format writing ~/.aws/sso/cache/kiro-auth-token.json
 * - mode 0o600:and IDE Be consistent (writeTokenToDisk use 0o600 Right now 384）
 * - social and IdC Field order alignment Kiro IDE Serialize results for manual convenience diff
 * - IdC Write client registration file at the same time {clientIdHash}.json
 */
async function writeKiroAuthTokenFile(input) {
    await fs.mkdir(exports.KIRO_SSO_CACHE_DIR, { recursive: true });
    const clientIdHash = computeClientIdHash(input.startUrl);
    const tokenData = input.authMethod === 'social'
        ? {
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            profileArn: input.profileArn,
            expiresAt: input.expiresAtIso,
            authMethod: input.authMethod,
            provider: input.provider
        }
        : {
            accessToken: input.accessToken,
            refreshToken: input.refreshToken,
            expiresAt: input.expiresAtIso,
            clientIdHash,
            authMethod: input.authMethod,
            provider: input.provider,
            region: input.region || 'us-east-1',
            profileArn: input.profileArn
        };
    await fs.writeFile(exports.KIRO_AUTH_TOKEN_PATH, JSON.stringify(tokenData, null, 2), {
        mode: 0o600
    });
    // Windows superior chmod right 0o600 yes no-op But don’t throw an error;Linux/macOS Make sure the permissions are correct
    try {
        await fs.chmod(exports.KIRO_AUTH_TOKEN_PATH, 0o600);
    }
    catch {
        /* ignore */
    }
    let clientRegPath;
    if (input.authMethod !== 'social' && input.clientId && input.clientSecret) {
        clientRegPath = path.join(exports.KIRO_SSO_CACHE_DIR, `${clientIdHash}.json`);
        // IDE Client registration validity period 90 sky(Kiro IDE Original method), the format is to remove Z of ISO string
        const clientExpiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace('Z', '');
        const clientData = {
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            expiresAt: clientExpiresAt,
            scopes: KIRO_OIDC_SCOPES
        };
        await fs.writeFile(clientRegPath, JSON.stringify(clientData, null, 2), { mode: 0o600 });
        try {
            await fs.chmod(clientRegPath, 0o600);
        }
        catch {
            /* ignore */
        }
    }
    return { tokenPath: exports.KIRO_AUTH_TOKEN_PATH, clientRegPath };
}
async function readKiroAuthTokenFile() {
    try {
        const content = await fs.readFile(exports.KIRO_AUTH_TOKEN_PATH, 'utf-8');
        const parsed = JSON.parse(content);
        if (!parsed.accessToken || !parsed.refreshToken)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function parseAccessTokenClaims(accessToken) {
    if (!accessToken)
        return null;
    const parts = accessToken.split('.');
    if (parts.length < 2)
        return null;
    try {
        let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4)
            b64 += '=';
        const json = Buffer.from(b64, 'base64').toString('utf-8');
        const claims = JSON.parse(json);
        const audRaw = claims.aud;
        const aud = typeof audRaw === 'string' ? audRaw : Array.isArray(audRaw) && typeof audRaw[0] === 'string' ? audRaw[0] : undefined;
        return {
            sub: typeof claims.sub === 'string' ? claims.sub : undefined,
            email: typeof claims.email === 'string' ? claims.email : undefined,
            aud,
            preferredUsername: typeof claims['preferred_username'] === 'string'
                ? claims['preferred_username']
                : undefined
        };
    }
    catch {
        return null;
    }
}
function watchKiroAuthTokenFile(onChange, intervalMs = 2000) {
    let debounceTimer = null;
    let lastSeenSig = '';
    let disposed = false;
    const tick = async () => {
        if (disposed)
            return;
        try {
            const token = await readKiroAuthTokenFile();
            if (!token)
                return;
            const sig = `${token.accessToken}|${token.refreshToken}`;
            if (sig === lastSeenSig)
                return;
            lastSeenSig = sig;
            await onChange(token);
        }
        catch (e) {
            // Silence:watcher shouldn't throw Affects the main process
            console.warn('[kiroAuthSync] watcher tick failed:', e);
        }
    };
    const listener = () => {
        if (debounceTimer)
            clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void tick();
        }, 600);
    };
    // Do a baseline reading first to avoid the first time after startup"False changes"
    void readKiroAuthTokenFile().then((t) => {
        if (t)
            lastSeenSig = `${t.accessToken}|${t.refreshToken}`;
    });
    fsSync.watchFile(exports.KIRO_AUTH_TOKEN_PATH, { interval: intervalMs }, listener);
    return () => {
        disposed = true;
        if (debounceTimer)
            clearTimeout(debounceTimer);
        fsSync.unwatchFile(exports.KIRO_AUTH_TOKEN_PATH, listener);
    };
}
