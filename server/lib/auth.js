'use strict'
// Stateless token auth (no deps). A token is base64url(payload).hmac where
// payload = { uid, iat, exp }. Signed with a server secret persisted in the
// data dir so tokens survive restarts. Express middleware attaches req.user.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const store = require('./store')

const SECRET_FILE = path.join(store.DATA_DIR, '.secret')
const TOKEN_TTL_SEC = 30 * 24 * 3600 // 30 days

const getSecret = () => {
  try { return fs.readFileSync(SECRET_FILE) } catch (_) {}
  const s = crypto.randomBytes(32)
  try { fs.mkdirSync(store.DATA_DIR, { recursive: true }) } catch (_) {}
  try { fs.writeFileSync(SECRET_FILE, s) } catch (_) {}
  return s
}
const SECRET = getSecret()

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlDecode = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

const sign = (payloadStr) => b64url(crypto.createHmac('sha256', SECRET).update(payloadStr).digest())

const issueToken = (user) => {
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({ uid: user.id, iat: now, exp: now + TOKEN_TTL_SEC }))
  return `${payload}.${sign(payload)}`
}

const verifyToken = (token) => {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  let data
  try { data = JSON.parse(b64urlDecode(payload).toString()) } catch (_) { return null }
  if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null
  return store.findById(data.uid) || null
}

const extractToken = (req) => {
  const h = req.headers.authorization
  if (h && h.startsWith('Bearer ')) return h.slice(7)
  if (req.query && req.query.token) return String(req.query.token)
  return null
}

// Attach req.user if a valid token is present (does not block).
const attachUser = (req, _res, next) => {
  req.user = verifyToken(extractToken(req)) || null
  next()
}

// Require any logged-in user.
const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '未登录或登录已过期' })
  next()
}

// Require admin.
const requireAdmin = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '未登录' })
  if (!req.user.isAdmin) return res.status(403).json({ error: '需要管理员权限' })
  next()
}

module.exports = { issueToken, verifyToken, attachUser, requireAuth, requireAdmin, TOKEN_TTL_SEC }
