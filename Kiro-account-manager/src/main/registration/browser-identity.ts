import crypto from 'crypto'

const LSUBID_PREFIXES = ['X10', 'X19', 'X42', 'X55', 'X73', 'X81', 'X96']

const GPU_CONFIGS = [
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) UHD Graphics 730 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) HD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) HD Graphics 530 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (Intel)', model: 'ANGLE (Intel, Intel(R) Iris(R) Plus Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 6GB Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (NVIDIA)', model: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', model: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', model: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', model: 'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', model: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  { vendor: 'Google Inc. (AMD)', model: 'ANGLE (AMD, AMD Radeon RX 570 Direct3D11 vs_5_0 ps_5_0, D3D11)' }
]

const SCREEN_CONFIGS: [number, number, number, number, number][] = [
  [1920, 1080, 1920, 1040, 24], [2560, 1440, 2560, 1400, 24],
  [1920, 1200, 1920, 1160, 24], [1366, 768, 1366, 728, 24],
  [1536, 864, 1536, 824, 24],   [1680, 1050, 1680, 1010, 24],
  [1440, 900, 1440, 860, 24],   [1600, 900, 1600, 860, 24],
  [2560, 1080, 2560, 1040, 24], [3440, 1440, 3440, 1400, 24],
  [3840, 2160, 3840, 2120, 24], [1280, 1024, 1280, 984, 24]
]

const MATH_POOL = [
  { tan: '-1.4214488238747245', sin: '0.8178819121159085', cos: '-0.5753861119575491' },
  { tan: '-1.4214488238747245', sin: '0.8178819121159085', cos: '-0.5765775004286854' },
  { tan: '-1.4214488238747243', sin: '0.8178819121159083', cos: '-0.5753861119575489' },
  { tan: '-1.4214488238747247', sin: '0.8178819121159087', cos: '-0.5753861119575493' },
  { tan: '-1.4214488238747244', sin: '0.8178819121159084', cos: '-0.5765775004286855' },
  { tan: '-1.4214488238747246', sin: '0.8178819121159086', cos: '-0.5753861119575490' },
  { tan: '-1.4214488238747242', sin: '0.8178819121159082', cos: '-0.5765775004286853' },
  { tan: '-1.4214488238747248', sin: '0.8178819121159088', cos: '-0.5753861119575492' },
  { tan: '-1.4214488238747241', sin: '0.8178819121159081', cos: '-0.5765775004286852' },
  { tan: '-1.4214488238747249', sin: '0.8178819121159089', cos: '-0.5753861119575494' }
]

const WEBGL_EXT_CORE = [
  'ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_color_buffer_half_float',
  'EXT_float_blend', 'EXT_frag_depth', 'EXT_shader_texture_lod',
  'EXT_texture_filter_anisotropic', 'EXT_sRGB', 'KHR_parallel_shader_compile',
  'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives',
  'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float',
  'OES_texture_half_float_linear', 'OES_vertex_array_object',
  'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders', 'WEBGL_depth_texture', 'WEBGL_draw_buffers',
  'WEBGL_lose_context', 'WEBGL_multi_draw'
]

const WEBGL_EXT_OPTIONAL = [
  'EXT_disjoint_timer_query', 'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc', 'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc', 'OES_draw_buffers_indexed',
  'EXT_color_buffer_float'
]

const PLUGINS_POOL = [
  { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
  { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
]

function randInt(max: number): number {
  return Math.floor(Math.random() * max)
}

function pick<T>(arr: readonly T[]): T {
  return arr[randInt(arr.length)]
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export interface ScreenInfo {
  width: number
  height: number
  availWidth: number
  availHeight: number
  colorDepth: number
}

export interface BrowserIdentity {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  webGLExts: string[]
  canvasHash: number
  histogramBase: number[]
  mathTan: string
  mathSin: string
  mathCos: string
  plugins: Array<{ name: string; filename: string; description: string }>
  screen: ScreenInfo
  lsubidPrefixSignin: string
  lsubidPrefixProfile: string
  webpackHash: string
}

function generateCanvasData(): { hash: number; histogram: number[] } {
  const bins = new Array<number>(256).fill(0)
  const totalSamples = 36000
  // Add more variation to avoid detectable patterns
  bins[0] = 10000 + randInt(8001) // Was 5001, now 8001 for more variance
  bins[255] = 12000 + randInt(6001) // Was 4001, now 6001

  // More varied color peak positions and values
  const numPeaks = 6 + randInt(4) // 6-9 peaks instead of fixed 8
  const peakPositions: number[] = []
  while (peakPositions.length < numPeaks) {
    const pos = randInt(254) + 1 // Avoid 0 and 255 (already set)
    if (!peakPositions.includes(pos)) {
      peakPositions.push(pos)
    }
  }
  
  for (let i = 0; i < peakPositions.length; i++) {
    bins[peakPositions[i]] = 50 + randInt(451) // 50-500 range for variety
  }

  let remaining = totalSamples - bins.reduce((a, b) => a + b, 0)
  for (let i = 1; i < 255; i++) {
    if (bins[i] === 0 && remaining > 0) {
      const v = Math.min(4 + randInt(97), remaining)
      bins[i] = v
      remaining -= v
    }
  }
  bins[0] += remaining

  const raw = Buffer.alloc(256 * 4)
  for (let i = 0; i < 256; i++) raw.writeUInt32LE(bins[i], i * 4)
  const digest = crypto.createHash('sha256').update(raw).digest()
  const hash = digest.readInt32LE(0)

  return { hash, histogram: bins }
}

/**
 * Generate true range Chrome Detailed version number (major.minor.build.patch）
 * Chrome Stable version format: major version.0.buildNumber.patchNumber
 * Randomly selected from several recent major versions,build/patch random within true range
 */
function randomChromeVersion(): string {
  // Recent stable moderator versions and their corresponding build Number range (from Chromium release history)
  const versions = [
    { major: 137, buildMin: 7151, buildMax: 7160 },
    { major: 138, buildMin: 7204, buildMax: 7213 },
    { major: 139, buildMin: 7259, buildMax: 7268 },
    { major: 140, buildMin: 7316, buildMax: 7325 },
    { major: 141, buildMin: 7371, buildMax: 7380 },
    { major: 142, buildMin: 7430, buildMax: 7439 },
    { major: 143, buildMin: 7485, buildMax: 7494 },
    { major: 144, buildMin: 7544, buildMax: 7553 },
    { major: 145, buildMin: 7601, buildMax: 7610 },
    { major: 146, buildMin: 7660, buildMax: 7669 },
  ]
  const v = versions[Math.floor(Math.random() * versions.length)]
  const build = v.buildMin + Math.floor(Math.random() * (v.buildMax - v.buildMin + 1))
  const patch = Math.floor(Math.random() * 150) // patch generally 0-150
  return `${v.major}.0.${build}.${patch}`
}

export function randomIdentity(): BrowserIdentity {
  const chromeVer = randomChromeVersion()
  const gpu = pick(GPU_CONFIGS)
  const scr = pick(SCREEN_CONFIGS)
  const math = pick(MATH_POOL)
  const { hash: canvasHash, histogram } = generateCanvasData()

  const exts = [...WEBGL_EXT_CORE]
  const nOpt = randInt(5)
  if (nOpt > 0) {
    const perm = shuffle([...Array(WEBGL_EXT_OPTIONAL.length).keys()])
    for (let i = 0; i < Math.min(nOpt, WEBGL_EXT_OPTIONAL.length); i++) {
      exts.push(WEBGL_EXT_OPTIONAL[perm[i]])
    }
  }
  exts.sort()

  const plugins = shuffle([...PLUGINS_POOL])

  return {
    chromeVer: chromeVer,
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
    gpuVendor: gpu.vendor,
    gpuModel: gpu.model,
    webGLExts: exts,
    canvasHash,
    histogramBase: histogram,
    mathTan: math.tan,
    mathSin: math.sin,
    mathCos: math.cos,
    plugins,
    screen: {
      width: scr[0], height: scr[1],
      availWidth: scr[2], availHeight: scr[3],
      colorDepth: scr[4]
    },
    lsubidPrefixSignin: pick(LSUBID_PREFIXES),
    lsubidPrefixProfile: pick(LSUBID_PREFIXES),
    webpackHash: randInt(0x7fffffff).toString(16).padStart(10, '0').slice(0, 10)
  }
}

export { randomFullName } from './names'
