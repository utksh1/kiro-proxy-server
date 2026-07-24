"use strict";
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
exports.loadSteeringDocuments = loadSteeringDocuments;
exports.formatSteeringForPrompt = formatSteeringForPrompt;
/**
 * Steering File loader: reading workspace .kiro/steering/*.md and parsed into injectable rule text.
 *
 * Steering Files support three inclusion modes (via YAML frontmatter specified):
 *   - always(default)- Injected on every request
 *   - fileMatch — When a request involves matching fileMatchPattern injected into the file
 *   - manual — Only injected when explicitly referenced by the user (anti-generation is skipped by default)
 */
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * Load all from workspace path steering document.
 * return press inclusion Classified document list (always priority).
 */
function loadSteeringDocuments(workspacePath) {
    const steeringDir = path.join(workspacePath, '.kiro', 'steering');
    if (!fs.existsSync(steeringDir))
        return [];
    const files = fs.readdirSync(steeringDir).filter(f => f.endsWith('.md'));
    const docs = [];
    for (const file of files) {
        try {
            const fullPath = path.join(steeringDir, file);
            const raw = fs.readFileSync(fullPath, 'utf-8');
            const { frontmatter, content } = parseFrontmatter(raw);
            docs.push({
                name: file,
                inclusion: frontmatter.inclusion || 'always',
                fileMatchPattern: frontmatter.fileMatchPattern,
                content: content.trim()
            });
        }
        catch (e) {
            console.warn(`[Steering] Failed to read ${file}:`, e);
        }
    }
    // always front of the line
    docs.sort((a, b) => {
        if (a.inclusion === 'always' && b.inclusion !== 'always')
            return -1;
        if (a.inclusion !== 'always' && b.inclusion === 'always')
            return 1;
        return 0;
    });
    return docs;
}
/**
 * Will steering The document list is formatted to be injected into system prompt text.
 * Contains only inclusion=always Documentation (reverse generation does not have file context Information, unable to judge fileMatch）。
 */
function formatSteeringForPrompt(docs) {
    const alwaysDocs = docs.filter(d => d.inclusion === 'always');
    if (alwaysDocs.length === 0)
        return '';
    const parts = alwaysDocs.map(d => `<!-- steering: ${d.name} -->\n${d.content}`);
    return `<steering-files>\n${parts.join('\n\n')}\n</steering-files>`;
}
/**
 * Simple analysis YAML frontmatter（--- separated key: value piece).
 */
function parseFrontmatter(raw) {
    const frontmatter = {};
    if (!raw.startsWith('---')) {
        return { frontmatter, content: raw };
    }
    const endIdx = raw.indexOf('\n---', 3);
    if (endIdx === -1) {
        return { frontmatter, content: raw };
    }
    const fmBlock = raw.slice(4, endIdx);
    const content = raw.slice(endIdx + 4);
    for (const line of fmBlock.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.slice(0, colonIdx).trim();
            const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (key && value)
                frontmatter[key] = value;
        }
    }
    return { frontmatter, content };
}
