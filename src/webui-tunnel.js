import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'

const DEFAULT_TTL_MINUTES = 30
const MAX_TTL_MINUTES = 60

export function parseWebUiCommand(text) {
  const match = String(text ?? '').trim().match(/^\/webui(?:\s+(stop|status|(?:(\d{1,2})(?:m|min)?)))?$/i)
  if (!match) return undefined
  if (match[1]?.toLowerCase() === 'stop') return { kind: 'stop' }
  if (match[1]?.toLowerCase() === 'status') return { kind: 'status' }
  const minutes = match[2] ? Number(match[2]) : DEFAULT_TTL_MINUTES
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TTL_MINUTES) {
    return { kind: 'invalid', message: `有效期只能设置为 1-${MAX_TTL_MINUTES} 分钟。` }
  }
  return { kind: 'start', minutes }
}

function cookieValue(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return undefined
}

export function authorizeWebUiRequest(req, token, maxAgeSeconds = 3600) {
  const prefix = `/${token}`
  const cookie = cookieValue(req.headers.cookie, 'dsh_webui')
  if (cookie === token) return { allowed: true, path: req.url }
  const rawUrl = String(req.url ?? '/')
  if (rawUrl !== prefix && !rawUrl.startsWith(`${prefix}/`)) return { allowed: false }
  const path = rawUrl.slice(prefix.length) || '/'
  return { allowed: true, path, setCookie: `dsh_webui=${token}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict` }
}

export function buildUpstreamHeaders(headers, targetPort, connection = 'close') {
  const localOrigin = `http://127.0.0.1:${targetPort}`
  const upstreamHeaders = {
    ...headers,
    host: `127.0.0.1:${targetPort}`,
    connection,
  }

  // DSH validates browser origins against its local listener. Requests arrive
  // through a public trycloudflare.com origin, so normalize browser-controlled
  // origin metadata before forwarding it to the loopback-only DSH service.
  if (upstreamHeaders.origin) upstreamHeaders.origin = localOrigin
  if (upstreamHeaders.referer) {
    try {
      const referer = new URL(String(upstreamHeaders.referer))
      upstreamHeaders.referer = `${localOrigin}${referer.pathname}${referer.search}${referer.hash}`
    } catch {
      delete upstreamHeaders.referer
    }
  }
  delete upstreamHeaders.forwarded
  delete upstreamHeaders['x-forwarded-host']
  delete upstreamHeaders['x-forwarded-proto']
  return upstreamHeaders
}

export class WebUiTunnelManager {
  constructor({ logger, cloudflaredPath = process.env.DSH_CLOUDFLARED_PATH || 'cloudflared', targetPort = 3080 } = {}) {
    this.logger = logger ?? console
    this.cloudflaredPath = cloudflaredPath
    this.targetPort = targetPort
    this.proxyServer = undefined
    this.proxy = undefined
    this.cloudflared = undefined
    this.tempHome = undefined
    this.expireTimer = undefined
    this.state = { state: 'stopped', detail: '没有运行中的临时 Web UI 地址' }
  }

  snapshot() {
    return { ...this.state }
  }

  async start(minutes = DEFAULT_TTL_MINUTES) {
    await this.stop()
    const token = randomBytes(24).toString('hex')
    this.proxyServer = http.createServer((req, res) => {
      const auth = authorizeWebUiRequest(req, token, minutes * 60)
      if (!auth.allowed) {
        res.writeHead(404, { 'cache-control': 'no-store' })
        res.end('Not found')
        return
      }
      req.url = auth.path
      this.proxyHttp(req, res, auth.setCookie)
    })
    this.proxyServer.on('upgrade', (req, socket, head) => {
      const auth = authorizeWebUiRequest(req, token, minutes * 60)
      if (!auth.allowed) {
        socket.destroy()
        return
      }
      req.url = auth.path
      this.proxyWebSocket(req, socket, head)
    })
    await new Promise((resolve, reject) => {
      this.proxyServer.once('error', reject)
      this.proxyServer.listen(0, '127.0.0.1', resolve)
    })
    const localPort = this.proxyServer.address().port
    this.tempHome = await mkdtemp(join(tmpdir(), 'dsh-webui-cloudflared-'))
    this.state = { state: 'starting', detail: '正在建立临时 Web UI 隧道' }

    const child = spawn(this.cloudflaredPath, [
      'tunnel', '--url', `http://127.0.0.1:${localPort}`, '--no-autoupdate',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: this.tempHome, XDG_CONFIG_HOME: this.tempHome },
    })
    this.cloudflared = child
    const publicUrl = await new Promise((resolve, reject) => {
      let settled = false
      let output = ''
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve(value)
      }
      const consume = chunk => {
        output += String(chunk)
        const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i)
        if (match) finish(undefined, match[0])
        if (output.length > 16_000) output = output.slice(-8_000)
      }
      child.stdout.on('data', consume)
      child.stderr.on('data', consume)
      child.once('error', error => {
        if (error?.code === 'ENOENT') {
          finish(new Error(`未找到 cloudflared（命令：${this.cloudflaredPath}），请先安装或设置 DSH_CLOUDFLARED_PATH`))
          return
        }
        finish(error)
      })
      child.once('exit', code => {
        if (!settled) finish(new Error(`cloudflared 提前退出，退出码 ${code ?? 'unknown'}`))
      })
      const timeout = setTimeout(() => finish(new Error('建立临时 Web UI 隧道超时')), 20_000)
      timeout.unref()
    }).catch(async error => {
      await this.stop()
      throw error
    })

    this.state = {
      state: 'running',
      detail: `临时地址有效期 ${minutes} 分钟`,
      url: `${publicUrl}/${token}/`,
      expiresAt: Date.now() + minutes * 60_000,
    }
    this.expireTimer = setTimeout(() => {
      this.stop().catch(error => this.logger.error(`关闭临时 Web UI 失败：${error.message}`))
    }, minutes * 60_000)
    this.expireTimer.unref()
    child.once('exit', code => {
      if (this.state.state === 'running') {
        this.state = { state: 'error', detail: `cloudflared 已退出，退出码 ${code ?? 'unknown'}` }
      }
    })
    return this.snapshot()
  }

  proxyHttp(req, res, setCookie) {
    const headers = buildUpstreamHeaders(req.headers, this.targetPort)
    const upstream = http.request({
      hostname: '127.0.0.1',
      port: this.targetPort,
      method: req.method,
      path: req.url,
      headers,
      agent: false,
    }, upstreamRes => {
      const responseHeaders = { ...upstreamRes.headers }
      if (setCookie) {
        const upstreamCookies = responseHeaders['set-cookie']
        responseHeaders['set-cookie'] = [
          ...(Array.isArray(upstreamCookies) ? upstreamCookies : upstreamCookies ? [upstreamCookies] : []),
          setCookie,
        ]
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      upstreamRes.pipe(res)
    })
    upstream.on('error', error => {
      this.logger.warn(`临时 Web UI 代理错误：${error.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Temporary Web UI tunnel is unavailable')
      } else {
        res.destroy()
      }
    })
    req.pipe(upstream)
  }

  proxyWebSocket(req, socket, head) {
    const upstream = net.connect(this.targetPort, '127.0.0.1')
    upstream.once('connect', () => {
      const headers = buildUpstreamHeaders(req.headers, this.targetPort, 'Upgrade')
      const request = [
        `${req.method} ${req.url} HTTP/${req.httpVersion}`,
        ...Object.entries(headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`),
        '',
        '',
      ].join('\r\n')
      upstream.write(request)
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', error => {
      this.logger.warn(`临时 Web UI WebSocket 代理错误：${error.message}`)
      socket.destroy()
    })
    socket.on('error', () => upstream.destroy())
  }

  async stop() {
    if (this.expireTimer) clearTimeout(this.expireTimer)
    this.expireTimer = undefined
    if (this.cloudflared && !this.cloudflared.killed) this.cloudflared.kill('SIGTERM')
    this.cloudflared = undefined
    if (this.proxyServer) await new Promise(resolve => this.proxyServer.close(() => resolve()))
    this.proxyServer = undefined
    if (this.tempHome) await rm(this.tempHome, { recursive: true, force: true })
    this.tempHome = undefined
    this.state = { state: 'stopped', detail: '没有运行中的临时 Web UI 地址' }
    return this.snapshot()
  }
}
