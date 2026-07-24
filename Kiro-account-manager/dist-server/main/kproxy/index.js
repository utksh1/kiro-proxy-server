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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.KProxyService = exports.MitmProxy = exports.CertManager = void 0;
exports.getKProxyService = getKProxyService;
exports.initKProxyService = initKProxyService;
exports.generateDeviceId = generateDeviceId;
exports.isValidDeviceId = isValidDeviceId;
// K-Proxy 模块入口
const path = __importStar(require("path"));
const certManager_1 = require("./certManager");
const mitmProxy_1 = require("./mitmProxy");
const types_1 = require("./types");
function getAppUserDataPath() {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const electron = require('electron');
        if (electron && electron.app && typeof electron.app.getPath === 'function') {
            return electron.app.getPath('userData');
        }
    }
    catch {
        // Headless or non-Electron environment
    }
    return process.env.DATA_DIR || path.join(process.cwd(), '.data');
}
// 导出类型
__exportStar(require("./types"), exports);
var certManager_2 = require("./certManager");
Object.defineProperty(exports, "CertManager", { enumerable: true, get: function () { return certManager_2.CertManager; } });
var mitmProxy_2 = require("./mitmProxy");
Object.defineProperty(exports, "MitmProxy", { enumerable: true, get: function () { return mitmProxy_2.MitmProxy; } });
/**
 * K-Proxy 服务管理器
 */
class KProxyService {
    certManager = null;
    mitmProxy = null;
    config;
    events;
    deviceIdMappings = new Map();
    dataPath;
    initialized = false;
    cachedCaInfo = null;
    constructor(config = {}, events = {}) {
        this.config = { ...types_1.DEFAULT_KPROXY_CONFIG, ...config };
        this.events = events;
        this.dataPath = path.join(getAppUserDataPath(), 'kproxy');
    }
    /**
     * 初始化服务（只初始化一次）
     */
    async initialize() {
        // 如果已初始化，直接返回缓存的 CA 信息
        if (this.initialized && this.cachedCaInfo) {
            console.log('[KProxyService] Already initialized, returning cached CA info');
            return this.cachedCaInfo;
        }
        // 初始化证书管理器
        this.certManager = (0, certManager_1.createCertManager)(this.dataPath);
        const caInfo = await this.certManager.initialize();
        // 初始化 MITM 代理
        this.mitmProxy = new mitmProxy_1.MitmProxy(this.certManager, this.config, this.events);
        this.initialized = true;
        this.cachedCaInfo = caInfo;
        console.log('[KProxyService] Initialized');
        return caInfo;
    }
    /**
     * 启动代理服务
     */
    async start() {
        if (!this.mitmProxy) {
            await this.initialize();
        }
        await this.mitmProxy.start();
        this.config.enabled = true;
    }
    /**
     * 停止代理服务
     */
    async stop() {
        if (this.mitmProxy) {
            await this.mitmProxy.stop();
        }
        this.config.enabled = false;
    }
    /**
     * 重启代理服务
     */
    async restart() {
        await this.stop();
        await this.start();
    }
    /**
     * 更新配置
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
        if (this.mitmProxy) {
            this.mitmProxy.updateConfig(this.config);
        }
    }
    /**
     * 获取配置
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * 获取统计信息
     */
    getStats() {
        return this.mitmProxy?.getStats() || null;
    }
    /**
     * 获取 CA 证书信息
     */
    getCACertInfo() {
        return this.certManager?.getCACertInfo() || null;
    }
    /**
     * 获取 CA 证书 PEM（用于导出/安装）
     */
    getCACertPem() {
        return this.certManager?.getCACertPem() || null;
    }
    /**
     * 设置当前设备 ID
     */
    setDeviceId(deviceId) {
        this.config.deviceId = deviceId;
        if (this.mitmProxy) {
            this.mitmProxy.updateConfig({ deviceId });
        }
    }
    /**
     * 获取当前设备 ID
     */
    getDeviceId() {
        return this.config.deviceId;
    }
    /**
     * 添加设备 ID 映射
     */
    addDeviceIdMapping(mapping) {
        this.deviceIdMappings.set(mapping.accountId, mapping);
    }
    /**
     * 移除设备 ID 映射
     */
    removeDeviceIdMapping(accountId) {
        this.deviceIdMappings.delete(accountId);
    }
    /**
     * 获取账号的设备 ID
     */
    getDeviceIdForAccount(accountId) {
        return this.deviceIdMappings.get(accountId)?.deviceId;
    }
    /**
     * 获取所有设备 ID 映射
     */
    getAllDeviceIdMappings() {
        return Array.from(this.deviceIdMappings.values());
    }
    /**
     * 切换到账号的设备 ID
     */
    switchToAccount(accountId) {
        const mapping = this.deviceIdMappings.get(accountId);
        if (mapping) {
            this.setDeviceId(mapping.deviceId);
            mapping.lastUsed = Date.now();
            return true;
        }
        return false;
    }
    /**
     * 检查是否运行中
     */
    isRunning() {
        return this.mitmProxy?.isRunning() || false;
    }
    /**
     * 重置统计
     */
    resetStats() {
        this.mitmProxy?.resetStats();
    }
    /**
     * 清除证书缓存
     */
    clearCertCache() {
        this.certManager?.clearCache();
    }
}
exports.KProxyService = KProxyService;
// 单例实例
let kproxyService = null;
/**
 * 获取 K-Proxy 服务实例
 */
function getKProxyService() {
    return kproxyService;
}
/**
 * 初始化 K-Proxy 服务
 */
function initKProxyService(config = {}, events = {}) {
    if (!kproxyService) {
        kproxyService = new KProxyService(config, events);
    }
    return kproxyService;
}
/**
 * 生成随机设备 ID（64位十六进制）
 */
function generateDeviceId() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
/**
 * 验证设备 ID 格式
 */
function isValidDeviceId(deviceId) {
    return /^[a-f0-9]{64}$/i.test(deviceId);
}
