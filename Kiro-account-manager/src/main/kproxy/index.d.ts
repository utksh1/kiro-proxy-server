import type { KProxyConfig, KProxyStats, KProxyEvents, CACertInfo, DeviceIdMapping } from './types';
export * from './types';
export { CertManager } from './certManager';
export { MitmProxy } from './mitmProxy';
/**
 * K-Proxy 服务管理器
 */
export declare class KProxyService {
    private certManager;
    private mitmProxy;
    private config;
    private events;
    private deviceIdMappings;
    private dataPath;
    private initialized;
    private cachedCaInfo;
    constructor(config?: Partial<KProxyConfig>, events?: KProxyEvents);
    /**
     * 初始化服务（只初始化一次）
     */
    initialize(): Promise<CACertInfo>;
    /**
     * 启动代理服务
     */
    start(): Promise<void>;
    /**
     * 停止代理服务
     */
    stop(): Promise<void>;
    /**
     * 重启代理服务
     */
    restart(): Promise<void>;
    /**
     * 更新配置
     */
    updateConfig(config: Partial<KProxyConfig>): void;
    /**
     * 获取配置
     */
    getConfig(): KProxyConfig;
    /**
     * 获取统计信息
     */
    getStats(): KProxyStats | null;
    /**
     * 获取 CA 证书信息
     */
    getCACertInfo(): CACertInfo | null;
    /**
     * 获取 CA 证书 PEM（用于导出/安装）
     */
    getCACertPem(): string | null;
    /**
     * 设置当前设备 ID
     */
    setDeviceId(deviceId: string): void;
    /**
     * 获取当前设备 ID
     */
    getDeviceId(): string | undefined;
    /**
     * 添加设备 ID 映射
     */
    addDeviceIdMapping(mapping: DeviceIdMapping): void;
    /**
     * 移除设备 ID 映射
     */
    removeDeviceIdMapping(accountId: string): void;
    /**
     * 获取账号的设备 ID
     */
    getDeviceIdForAccount(accountId: string): string | undefined;
    /**
     * 获取所有设备 ID 映射
     */
    getAllDeviceIdMappings(): DeviceIdMapping[];
    /**
     * 切换到账号的设备 ID
     */
    switchToAccount(accountId: string): boolean;
    /**
     * 检查是否运行中
     */
    isRunning(): boolean;
    /**
     * 重置统计
     */
    resetStats(): void;
    /**
     * 清除证书缓存
     */
    clearCertCache(): void;
}
/**
 * 获取 K-Proxy 服务实例
 */
export declare function getKProxyService(): KProxyService | null;
/**
 * 初始化 K-Proxy 服务
 */
export declare function initKProxyService(config?: Partial<KProxyConfig>, events?: KProxyEvents): KProxyService;
/**
 * 生成随机设备 ID（64位十六进制）
 */
export declare function generateDeviceId(): string;
/**
 * 验证设备 ID 格式
 */
export declare function isValidDeviceId(deviceId: string): boolean;
