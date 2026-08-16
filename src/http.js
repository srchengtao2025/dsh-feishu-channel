import { timingSafeEqual } from 'node:crypto'

export async function readJson(req, maxBytes = 32 * 1024) {
  const type = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim()
  if (type !== 'application/json') throw Object.assign(new Error('Content-Type 必须是 application/json'), { statusCode: 415 })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw Object.assign(new Error('请求体不是有效 JSON'), { statusCode: 400 })
  }
}

export function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

export function sendHtml(res, html) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })
  res.end(html)
}

export function validCsrf(req, expected) {
  const actual = String(req.headers['x-feishu-csrf'] ?? '')
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function isSameOrigin(req) {
  const host = String(req.headers.host ?? '')
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(String(origin))
    return url.host === host && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
  } catch {
    return false
  }
}
