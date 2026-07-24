"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolNameRegistry = void 0;
class ToolNameRegistry {
    originalToKiro = new Map();
    kiroToOriginal = new Map();
    toKiroName(name) {
        const existing = this.originalToKiro.get(name);
        if (existing)
            return existing;
        const baseName = name.length <= 64 ? name : this.shorten(name);
        const kiroName = this.ensureUnique(baseName, name);
        this.originalToKiro.set(name, kiroName);
        this.kiroToOriginal.set(kiroName, name);
        return kiroName;
    }
    toClientName(name) {
        return this.kiroToOriginal.get(name) || name;
    }
    restoreToolUse(toolUse) {
        return {
            ...toolUse,
            name: this.toClientName(toolUse.name)
        };
    }
    restoreToolUses(toolUses) {
        return toolUses.map(toolUse => this.restoreToolUse(toolUse));
    }
    ensureUnique(baseName, originalName) {
        const existing = this.kiroToOriginal.get(baseName);
        if (!existing || existing === originalName)
            return baseName;
        const hash = this.hash(originalName);
        const suffix = `_${hash}`;
        const candidate = baseName.substring(0, Math.max(1, 64 - suffix.length)) + suffix;
        const candidateExisting = this.kiroToOriginal.get(candidate);
        if (!candidateExisting || candidateExisting === originalName)
            return candidate;
        throw new Error(`Tool name collision after shortening: ${originalName}`);
    }
    shorten(name) {
        const hash = this.hash(name);
        const suffix = `_${hash}`;
        const readable = name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const maxPrefixLength = 64 - suffix.length;
        return readable.substring(0, maxPrefixLength) + suffix;
    }
    hash(value) {
        let hash = 2166136261;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }
}
exports.ToolNameRegistry = ToolNameRegistry;
