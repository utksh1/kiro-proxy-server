"use strict";
// K-Proxy 类型定义
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_KPROXY_CONFIG = exports.DEFAULT_MITM_DOMAINS = void 0;
/**
 * 默认 MITM 域名白名单
 */
exports.DEFAULT_MITM_DOMAINS = [
    'amazonaws.com',
    'amazon.com',
    'kiro.dev'
];
/**
 * 默认 K-Proxy 配置
 */
exports.DEFAULT_KPROXY_CONFIG = {
    enabled: false,
    port: 8899,
    host: '127.0.0.1',
    mitmDomains: exports.DEFAULT_MITM_DOMAINS,
    autoStart: false,
    logRequests: true
};
