// Local relay agent chain (Proxy Chaining）
//
// Background: Some target proxies (e.g. bestproxy) requires "source IP Must be non-mainland", mainland IP It can neither be added to the whitelist nor will it be rejected (610）。
// Ground floor TLS The engine only supports a single-layer proxy, so here we set up a local relay on this machine and string the link into:
//   local machine → local trunk → upstream transfer(non-continent, upstream) → target agent(target, bestproxy) → target site
// This way the destination agent sees the source IP If it is the upstream transit exit (non-mainland), you can pass through.
//
// Only implement HTTP CONNECT Inbound (the entire registration process is https, sufficient); upstream transit support http / socks5(4)。

import net from 'net'
import { SocksClient } from 'socks'

interface ParsedChainProxy {
  protocol: 'http' | 'https' | 'socks5' | 'socks4'
  host: string
  port: number
  username?: string
  password?: string
}

function parseChainProxy(url: string): ParsedChainProxy | null {
  try {
    const u = new URL(url)
    const proto = u.protocol.replace(':', '').toLowerCase()
    let protocol: ParsedChainProxy['protocol']
    if (proto === 'http') protocol = 'http'
    else if (proto === 'https') protocol = 'https'
    else if (proto === 'socks5' || proto === 'socks5h' || proto === 'socks') protocol = 'socks5'
    else if (proto === 'socks4' || proto === 'socks4a') protocol = 'socks4'
    else return null
    const port = Number(u.port) || (protocol.startsWith('socks') ? 1080 : 8080)
    if (!u.hostname) return null
    return {
      protocol,
      host: u.hostname,
      port,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined
    }
  } catch {
    return null
  }
}

interface ConnectResponse {
  status: number
  statusText: string
  headersRaw: string
  bodySnippet: string
}

export interface ChainDiagnose {
  upstreamReachable: boolean
  upstreamError?: string
  upstreamRtMs?: number
  targetReachable: boolean
  targetError?: string
  targetRtMs?: number
  targetStatus?: number
  targetStatusText?: string
  targetBodySnippet?: string
  endToEndOk?: boolean
  endToEndError?: string
  endToEndRtMs?: number
}

export class ChainProxyRelay {
  private server: net.Server | null = null
  /** Track all active inbound connections,stop() Forced destruction when necessary to avoid server.close() wait Keep-Alive time out(~60s）*/
  private sockets = new Set<net.Socket>()
  private readonly upstream: ParsedChainProxy
  private readonly target: ParsedChainProxy
  private readonly log: (m: string) => void
  port = 0

  constructor(upstreamUrl: string, targetUrl: string, log?: (m: string) => void) {
    const up = parseChainProxy(upstreamUrl)
    const tg = parseChainProxy(targetUrl)
    if (!up) throw new Error(`The upstream relay agent is invalid: ${upstreamUrl}`)
    if (!tg) throw new Error(`Target proxy is invalid: ${targetUrl}`)
    this.upstream = up
    this.target = tg
    this.log = log || ((): void => {})
  }

  /** Start the local relay and return the http://127.0.0.1:port */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => this.handleClient(client))
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
          this.server = server
          server.removeListener('error', reject)
          resolve(`http://127.0.0.1:${this.port}`)
        } else {
          reject(new Error('Local relay startup failed: Unable to get port'))
        }
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const srv = this.server
      this.server = null
      // Force the destruction of all active tunnel connections: otherwise server.close() Will wait DLL Go http.Transport
      // of Keep-Alive Natural connection timeout (~60s), causing the registration to end cleanup stuck for a minute
      for (const sock of this.sockets) {
        try { sock.destroy() } catch { /* ignore */ }
      }
      this.sockets.clear()
      if (!srv) {
        resolve()
        return
      }
      srv.close(() => resolve())
      // Double insurance:500ms Regardless close Whether the callback is triggered or not resolve
      setTimeout(resolve, 500)
    })
  }

  private handleClient(client: net.Socket): void {
    this.sockets.add(client)
    client.on('close', () => this.sockets.delete(client))
    client.on('error', () => client.destroy())
    client.once('data', (chunk) => {
      const head = chunk.toString('latin1')
      const m = head.match(/^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]/i)
      if (!m) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        return
      }
      const host = m[1]
      const port = Number(m[2])
      this.dialChain(host, port)
        .then((tunnel) => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          client.pipe(tunnel)
          tunnel.pipe(client)
          client.on('close', () => tunnel.destroy())
          tunnel.on('close', () => client.destroy())
          tunnel.on('error', () => { client.destroy(); tunnel.destroy() })
        })
        .catch((err: unknown) => {
          this.log(`[ProxyChain] Tunnel establishment failed: ${err instanceof Error ? err.message : String(err)}`)
          if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        })
    })
  }

  /** Connect to the target proxy entrance through the upstream relay, and then perform operations on the target proxy on this connection. CONNECT reach final goal */
  private async dialChain(host: string, port: number): Promise<net.Socket> {
    const sock = await this.connectViaUpstream(this.target.host, this.target.port)
    try {
      const resp = await this.sendConnectRequest(sock, host, port, this.target)
      if (resp.status !== 200) {
        throw new Error(this.formatConnectError('target agent', resp))
      }
    } catch (err) {
      sock.destroy()
      throw err
    }
    return sock
  }

  private connectViaUpstream(host: string, port: number): Promise<net.Socket> {
    if (this.upstream.protocol === 'socks5' || this.upstream.protocol === 'socks4') {
      return this.connectViaSocks(host, port)
    }
    return this.connectViaHttpUpstream(host, port)
  }

  private connectViaHttpUpstream(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.upstream.port, this.upstream.host)
      sock.setTimeout(20000)
      sock.once('timeout', () => { sock.destroy(); reject(new Error('Upstream transit connection timeout')) })
      sock.once('error', reject)
      sock.once('connect', () => {
        sock.setNoDelay(true)
        this.sendConnectRequest(sock, host, port, this.upstream)
          .then((resp) => {
            sock.setTimeout(0)
            if (resp.status === 200) resolve(sock)
            else { sock.destroy(); reject(new Error(this.formatConnectError('upstream transfer', resp))) }
          })
          .catch((err: Error) => { sock.destroy(); reject(err) })
      })
    })
  }

  private connectViaSocks(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      void SocksClient.createConnection({
        proxy: {
          host: this.upstream.host,
          port: this.upstream.port,
          type: this.upstream.protocol === 'socks4' ? 4 : 5,
          userId: this.upstream.username,
          password: this.upstream.password
        },
        command: 'connect',
        destination: { host, port },
        timeout: 20000
      })
        .then(({ socket }) => {
          // socks package returned socket Enabled by default 30s timeout, will be triggered after idle 'end', leading us to misjudge that"Closed by peer"
          socket.setTimeout(0)
          socket.setNoDelay(true)
          socket.setKeepAlive(true, 30000)
          resolve(socket)
        })
        .catch((err: Error) => reject(err))
    })
  }

  /**
   * Universal CONNECT:Send request + Parse the response.
   *
   * Key fault tolerance:
   *   - Some agents only send a status line when returning an error. close，**Not to make up for \r\n\r\n**(like bestproxy of 610），
   *     The old implementation would wait for an empty line until FIN trigger 'end' Then it falsely reports "the proxy connection was closed by the peer" and the error status code is lost.
   *     New implementation:'end' If the event is triggered buf Status line included, best effort to parse; only empty buf It just reported "closed".
   *   - Comes with common compatible headers (Proxy-Connection / User-Agent) to reduce strategic rejection on the proxy server.
   */
  private sendConnectRequest(
    sock: net.Socket,
    host: string,
    port: number,
    auth: ParsedChainProxy
  ): Promise<ConnectResponse> {
    return new Promise((resolve, reject) => {
      const lines = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Proxy-Connection: keep-alive',
        'User-Agent: Mozilla/5.0'
      ]
      if (auth.username) {
        const b64 = Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64')
        lines.push(`Proxy-Authorization: Basic ${b64}`)
      }
      const req = lines.join('\r\n') + '\r\n\r\n'

      this.readHttpResponse(sock).then(resolve, reject)
      sock.write(req)
    })
  }

  /** read HTTP Response: until \r\n\r\n Complete, or peer closed/Try to resolve errors when they occur. Return structured results. */
  private readHttpResponse(sock: net.Socket): Promise<ConnectResponse> {
    return new Promise((resolve, reject) => {
      let buf = ''
      const cleanup = (): void => {
        sock.removeListener('data', onData)
        sock.removeListener('error', onErr)
        sock.removeListener('end', onEnd)
        sock.removeListener('close', onEnd)
      }
      const parse = (raw: string): ConnectResponse | null => {
        const nlIdx = raw.indexOf('\r\n')
        if (nlIdx < 0) return null
        const statusLine = raw.slice(0, nlIdx)
        const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})\s*(.*)$/)
        if (!m) return null
        const status = Number(m[1])
        const statusText = m[2] || ''
        const sep = raw.indexOf('\r\n\r\n')
        const headersEnd = sep >= 0 ? sep : raw.length
        const headersRaw = raw.slice(nlIdx + 2, headersEnd)
        const bodySnippet = sep >= 0 ? raw.slice(sep + 4, sep + 4 + 200) : ''
        return { status, statusText, headersRaw, bodySnippet }
      }
      const finish = (raw: string, viaClose: boolean): void => {
        cleanup()
        const parsed = parse(raw)
        if (parsed) {
          if (parsed.status === 200 && raw.indexOf('\r\n\r\n') >= 0) {
            const sep = raw.indexOf('\r\n\r\n')
            const rest = raw.slice(sep + 4)
            if (rest.length > 0) sock.unshift(Buffer.from(rest, 'latin1'))
          }
          resolve(parsed)
        } else if (viaClose) {
          reject(new Error(raw ? `Proxy returns unresolvable: ${raw.slice(0, 120)}` : 'The proxy connection was closed by the peer (no response)'))
        }
      }
      const onData = (d: Buffer): void => {
        buf += d.toString('latin1')
        const sep = buf.indexOf('\r\n\r\n')
        if (sep >= 0) finish(buf, false)
      }
      const onErr = (err: Error): void => { cleanup(); reject(err) }
      const onEnd = (): void => finish(buf, true)
      sock.on('data', onData)
      sock.once('error', onErr)
      sock.once('end', onEnd)
      sock.once('close', onEnd)
    })
  }

  private formatConnectError(stage: string, resp: ConnectResponse): string {
    const suffix = resp.bodySnippet ? ` body=${resp.bodySnippet.replace(/[\r\n]/g, ' ').slice(0, 120)}` : ''
    return `${stage} CONNECT fail: HTTP ${resp.status} ${resp.statusText}${suffix}`
  }

  /**
   * Staged diagnosis:
   *   A) upstream transfer TCP connected
   *   B) via upstream CONNECT To the target agent entrance
   *   C) via complete link CONNECT arrive testHost:testPort
   * Does not rely on local server, available independently; locate the problem to which layer it is accurate.
   */
  async diagnose(testHost = 'www.gstatic.com', testPort = 443): Promise<ChainDiagnose> {
    const result: ChainDiagnose = { upstreamReachable: false, targetReachable: false }
    const t0 = Date.now()
    try {
      await this.tcpProbe(this.upstream.host, this.upstream.port, 8000)
      result.upstreamReachable = true
      result.upstreamRtMs = Date.now() - t0
    } catch (err) {
      result.upstreamError = err instanceof Error ? err.message : String(err)
      return result
    }
    const t1 = Date.now()
    let chainSock: net.Socket | null = null
    try {
      chainSock = await this.connectViaUpstream(this.target.host, this.target.port)
      result.targetReachable = true
      result.targetRtMs = Date.now() - t1
    } catch (err) {
      result.targetError = err instanceof Error ? err.message : String(err)
      return result
    }
    const t2 = Date.now()
    try {
      const resp = await this.sendConnectRequest(chainSock, testHost, testPort, this.target)
      result.targetStatus = resp.status
      result.targetStatusText = resp.statusText
      result.targetBodySnippet = resp.bodySnippet
      result.endToEndOk = resp.status === 200
      result.endToEndRtMs = Date.now() - t2
      if (resp.status !== 200) {
        result.endToEndError = `target agent rejects: HTTP ${resp.status} ${resp.statusText}`
      }
    } catch (err) {
      result.endToEndOk = false
      result.endToEndError = err instanceof Error ? err.message : String(err)
    } finally {
      chainSock.destroy()
    }
    return result
  }

  private tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, host)
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`TCP Connection timeout ${host}:${port}`)) }, timeoutMs)
      sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve() })
      sock.once('error', (err) => { clearTimeout(timer); reject(err) })
    })
  }
}
