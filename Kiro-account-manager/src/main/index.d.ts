type UsageApiType = 'rest' | 'cbor';
export declare function setUsageApiType(type: UsageApiType): void;
export declare function getUsageApiType(): UsageApiType;
export declare function setUseKProxyForApi(enabled: boolean): void;
export declare function getUseKProxyForApi(): boolean;
/**
 * normalized proxy URL,make sure protocol://host:port Format.
 * Error-tolerant handling of common format errors by users:
 *   http:127.0.0.1:7890     → http://127.0.0.1:7890   (lack //)
 *   http:/127.0.0.1:7890    → http://127.0.0.1:7890   (one /)
 *   127.0.0.1:7890          → http://127.0.0.1:7890   (none protocol)
 *   http://127.0.0.1:7890   → http://127.0.0.1:7890   (Standardized)
 */
export declare function normalizeProxyUrl(url: string): string;
export {};
