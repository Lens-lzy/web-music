'use strict'
// Web music player backend.
//   - /api/search  : search songs (built-in musicSdk, e.g. Kuwo)
//   - /api/url     : resolve a playable URL via a third-party source script
//   - /api/lyric   : lyric  (musicSdk)
//   - /api/pic     : album art (musicSdk)
//   - /api/sources : list loaded source scripts
//   - /api/proxy/audio : stream third-party audio (adds Referer/UA, enables seek)
//   - static       : serves ../public (the NetEase-style frontend)

const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')
const express = require('express')

const sources = require('./lib/sources')
const store = require('./lib/store')
const auth = require('./lib/auth')
const charts = require('./lib/charts')
const recommend = require('./lib/recommend')

// Built-in search/lyric/pic providers (ported from lx-music musicSdk).
// Each key is a platform id; value is a module with search/getLyric/getPic.
const musicSdk = {}
try { musicSdk.kg = require('./musicSdk/kg') } catch (e) { console.warn('[musicSdk] kg not loaded:', e.message) }
try { musicSdk.kw = require('./musicSdk/kw') } catch (e) { console.warn('[musicSdk] kw not loaded:', e.message) }

const PORT = process.env.PORT || 9277
const HOST = process.env.HOST || process.env.BIND_HOST || '0.0.0.0'
// Open self-registration is on by default; set WEB_MUSIC_DISABLE_REGISTER=1 to close it.
const ALLOW_REGISTER = !process.env.WEB_MUSIC_DISABLE_REGISTER
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public')

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(auth.attachUser) // attaches req.user when a valid token is present

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch(err => {
  console.error('[api error]', err)
  res.status(500).json({ error: err.message })
})

// Probe a candidate URL (following redirects) and decide whether it is real
// audio rather than an ISP/anti-leech HTML block page. Resolves to true/false.
const isPlayableAudio = (urlStr, redirectsLeft = 5) => new Promise((resolve) => {
  let urlObj
  try { urlObj = new URL(urlStr) } catch (e) { return resolve(false) }
  const lib = urlObj.protocol === 'https:' ? https : http
  const req = lib.request(urlObj, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Range: 'bytes=0-1024',
    },
  }, (r) => {
    if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
      r.resume()
      if (redirectsLeft <= 0) return resolve(false)
      return resolve(isPlayableAudio(new URL(r.headers.location, urlObj).toString(), redirectsLeft - 1))
    }
    const ct = (r.headers['content-type'] || '').toLowerCase()
    const chunks = []
    r.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length >= 1024) req.destroy() })
    const finish = () => {
      const b = Buffer.concat(chunks)
      const isAudioCt = ct.includes('audio') || ct.includes('octet-stream') || ct.includes('mpeg')
      const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33
      const frame = b[0] === 0xff && (b[1] & 0xe0) === 0xe0
      const isHtml = b.slice(0, 6).toString().toLowerCase().startsWith('<html') || b.slice(0, 5).toString() === '<h2>x' || ct.includes('text/html')
      resolve((isAudioCt || id3 || frame) && !isHtml)
    }
    r.on('end', finish)
    r.on('close', finish)
  })
  req.on('error', () => resolve(false))
  req.setTimeout(8000, () => { req.destroy(); resolve(false) })
  req.end()
})

// ---- meta ----
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }))

// =====================================================================
//  Auth & user management (Navidrome-style)
// =====================================================================

// public client config (drives whether the register UI is shown). Registration
// is invite-only: it always requires a valid invite code.
app.get('/api/config', (req, res) => res.json({ allowRegister: ALLOW_REGISTER, inviteRequired: true }))

// login -> { token, user }
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {}
  const u = store.authenticate(username, password)
  if (!u) return res.status(401).json({ error: '用户名或密码错误' })
  res.json({ token: auth.issueToken(u), user: store.publicUser(u) })
}))

// invite-only registration: requires a valid, unused invite code. On success
// creates a regular member, consumes the code, and auto-logs in -> { token, user }
app.post('/api/register', wrap(async (req, res) => {
  if (!ALLOW_REGISTER) return res.status(403).json({ error: '当前未开放注册，请联系管理员' })
  const { username, password, inviteCode } = req.body || {}
  store.validateInvite(inviteCode)                                   // throws 邀请码无效/已被使用
  const u = store.createUser({ username, password, isAdmin: false }) // isAdmin from client is ignored
  store.consumeInvite(inviteCode, u.username)                        // mark the code used (only after user created)
  const full = store.findById(u.id)
  res.json({ token: auth.issueToken(full), user: u })
}))

// who am I (validates token)
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ user: store.publicUser(req.user) }))

// change own password
app.post('/api/me/password', auth.requireAuth, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!store.verifyPassword(oldPassword, req.user.passwordHash)) {
    return res.status(400).json({ error: '原密码错误' })
  }
  store.setPassword(req.user.id, newPassword)
  res.json({ ok: true })
}))

// ---- per-user playlists (my-liked is the default, non-deletable one) ----
// All scoped to the logged-in user, so accounts never share data.
app.get('/api/playlists', auth.requireAuth, (req, res) => {
  res.json({ playlists: store.getPlaylists(req.user.id) })
})
app.get('/api/playlists/:id', auth.requireAuth, wrap(async (req, res) => {
  res.json({ playlist: store.getPlaylist(req.user.id, req.params.id) })
}))
app.post('/api/playlists', auth.requireAuth, wrap(async (req, res) => {
  res.json({ playlist: store.createPlaylist(req.user.id, (req.body || {}).name) })
}))
app.delete('/api/playlists/:id', auth.requireAuth, wrap(async (req, res) => {
  store.deletePlaylist(req.user.id, req.params.id)
  res.json({ ok: true })
}))
app.post('/api/playlists/:id/rename', auth.requireAuth, wrap(async (req, res) => {
  res.json({ playlist: store.renamePlaylist(req.user.id, req.params.id, (req.body || {}).name) })
}))
// add a song to a playlist
app.post('/api/playlists/:id/songs', auth.requireAuth, wrap(async (req, res) => {
  res.json(store.addToPlaylist(req.user.id, req.params.id, (req.body || {}).song))
}))
// remove a song from a playlist by its key
app.delete('/api/playlists/:id/songs', auth.requireAuth, wrap(async (req, res) => {
  const key = req.query.key || (req.body || {}).key
  if (!key) return res.status(400).json({ error: 'song key required' })
  res.json(store.removeFromPlaylist(req.user.id, req.params.id, String(key)))
}))

// ---- play queue (persisted so a page refresh keeps the playlist) ----
app.get('/api/queue', auth.requireAuth, (req, res) => {
  res.json(store.getQueue(req.user.id))
})
app.put('/api/queue', auth.requireAuth, wrap(async (req, res) => {
  const { songs = [], idx = -1 } = req.body || {}
  res.json(store.setQueue(req.user.id, songs, idx))
}))

// ---- admin: member management ----
app.get('/api/admin/users', auth.requireAdmin, (req, res) => res.json({ users: store.listUsers() }))

app.post('/api/admin/users', auth.requireAdmin, wrap(async (req, res) => {
  const { username, password, isAdmin } = req.body || {}
  const u = store.createUser({ username, password, isAdmin })
  res.json({ user: u })
}))

app.delete('/api/admin/users/:id', auth.requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id)
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' })
  store.deleteUser(id)
  res.json({ ok: true })
}))

// reset a member's password. With no body -> generate a random temp password,
// force the user to change it on next login, and return it so the admin can
// pass it on. With { newPassword } -> set that specific password.
app.post('/api/admin/users/:id/password', auth.requireAdmin, wrap(async (req, res) => {
  const { newPassword } = req.body || {}
  if (newPassword) {
    store.setPassword(Number(req.params.id), newPassword)
    return res.json({ ok: true })
  }
  const password = store.adminResetPassword(Number(req.params.id))
  res.json({ ok: true, password })
}))
app.post('/api/admin/users/:id/admin', auth.requireAdmin, wrap(async (req, res) => {
  const u = store.setAdmin(Number(req.params.id), !!(req.body || {}).isAdmin)
  res.json({ user: u })
}))

// ---- admin: invite codes (single-use, required for registration) ----
app.get('/api/admin/invites', auth.requireAdmin, (req, res) => res.json({ invites: store.listInvites() }))
app.post('/api/admin/invites', auth.requireAdmin, wrap(async (req, res) => {
  res.json({ invite: store.createInvite(req.user.username) })
}))
app.delete('/api/admin/invites/:code', auth.requireAdmin, wrap(async (req, res) => {
  store.deleteInvite(req.params.code)
  res.json({ ok: true })
}))

// =====================================================================
//  Music APIs — all require a logged-in user
// =====================================================================

app.get('/api/sources', auth.requireAuth, (req, res) => res.json({ sources: sources.list() }))

// list available search platforms (musicSdk)
app.get('/api/platforms', auth.requireAuth, (req, res) => res.json({ platforms: Object.keys(musicSdk) }))

// 精选首页：定时抓取的热门榜单卡片
app.get('/api/featured', auth.requireAuth, (req, res) => res.json(charts.get()))

// 记录一次播放（用于个性化推荐）
app.post('/api/history', auth.requireAuth, wrap(async (req, res) => {
  const song = (req.body || {}).song
  if (song && song.source) store.addHistory(req.user.id, song, Date.now())
  res.json({ ok: true })
}))

// 个性化推荐：每日推荐 + 「因为你喜欢」卡片（按早 6 点为界缓存）
app.get('/api/recommend', auth.requireAuth, wrap(async (req, res) => {
  const force = req.query.force === '1'
  res.json(await recommend.getRecommend(req.user.id, Date.now(), force))
}))

// 随便听听：喜好加权随机 30 首（每次重算）
app.get('/api/shuffle', auth.requireAuth, wrap(async (req, res) => {
  res.json({ songs: await recommend.getShuffle(req.user.id, Date.now()) })
}))

// ---- search ----
app.get('/api/search', auth.requireAuth, wrap(async (req, res) => {
  const keyword = String(req.query.keyword || req.query.q || '').trim()
  const platform = String(req.query.platform || 'kg')
  const page = parseInt(req.query.page) || 1
  const limit = parseInt(req.query.limit) || 30
  if (!keyword) return res.status(400).json({ error: 'keyword required' })
  const sdk = musicSdk[platform]
  if (!sdk || !sdk.search) return res.status(400).json({ error: `platform "${platform}" unsupported` })
  const result = await sdk.search(keyword, page, limit)
  if (page === 1) store.addSearchHistory(req.user.id, keyword) // 仅首页搜索记入历史
  res.json(result)
}))

// ---- search history ----
app.get('/api/search/history', auth.requireAuth, (req, res) => res.json({ history: store.getSearchHistory(req.user.id) }))
app.delete('/api/search/history', auth.requireAuth, (req, res) => {
  const kw = req.query.keyword
  if (kw) return res.json({ history: store.removeSearchHistory(req.user.id, String(kw)) })
  return res.json({ history: store.clearSearchHistory(req.user.id) }) // 无 keyword = 清空
})

// ---- resolve playable url ----
// POST { musicInfo, quality?, sourceScript? }  (musicInfo comes from /api/search)
app.post('/api/url', auth.requireAuth, wrap(async (req, res) => {
  const { musicInfo, quality = '128k', sourceScript } = req.body || {}
  if (!musicInfo || !musicInfo.source) return res.status(400).json({ error: 'musicInfo with .source required' })

  // Candidate source scripts: explicit one, else every ready source (tried in order).
  let candidates
  if (sourceScript) {
    const s = sources.get(sourceScript)
    if (!s) return res.status(404).json({ error: `source script "${sourceScript}" not found` })
    candidates = [s]
  } else {
    candidates = sources.list().filter(s => s.ready).map(s => sources.get(s.id))
  }
  if (!candidates.length) return res.status(503).json({ error: 'no music source script available' })

  // validate=0 disables the audio-reachability check (faster, but may hand back
  // a dead/blocked link). Default on.
  const validate = req.query.validate !== '0' && req.body.validate !== false

  // Resolve one source: get url, then (if validating) confirm it's real audio.
  const resolveOne = async (src) => {
    const url = await src.getMusicUrl(musicInfo.source, musicInfo, quality)
    if (validate) {
      const ok = await isPlayableAudio(url)
      if (!ok) throw new Error('returned a non-audio/blocked link')
    }
    return { url, sourceScript: src.id }
  }

  // Single explicit source → no racing.
  if (sourceScript) {
    try {
      const r = await resolveOne(candidates[0])
      return res.json({ ...r, validated: validate, proxied: `/api/proxy/audio?url=${encodeURIComponent(r.url)}` })
    } catch (e) {
      return res.status(502).json({ error: `source "${candidates[0].id}" failed`, detail: e.message })
    }
  }

  // Auto mode: race all ready sources concurrently, take the FIRST that yields
  // verified audio. This hides single-source timeouts/blocks (e.g. juhe's
  // occasional timeout is covered by lx finishing in parallel).
  const errors = []
  let fallbackUrl = null
  let fallbackSrc = null
  const winner = await new Promise((resolve) => {
    let pending = candidates.length
    candidates.forEach(src => {
      // capture an unvalidated url as a last-resort fallback
      src.getMusicUrl(musicInfo.source, musicInfo, quality)
        .then(async (url) => {
          if (!fallbackUrl) { fallbackUrl = url; fallbackSrc = src.id }
          if (!validate || await isPlayableAudio(url)) return resolve({ url, sourceScript: src.id })
          throw new Error('non-audio/blocked')
        })
        .catch(e => { errors.push(`${src.id}: ${e.message}`) })
        .finally(() => { if (--pending === 0) resolve(null) })
    })
  })

  if (winner) {
    return res.json({ ...winner, validated: validate, proxied: `/api/proxy/audio?url=${encodeURIComponent(winner.url)}` })
  }
  if (fallbackUrl) {
    return res.json({ url: fallbackUrl, sourceScript: fallbackSrc, validated: false, warning: 'no source produced a verified-audio link', detail: errors, proxied: `/api/proxy/audio?url=${encodeURIComponent(fallbackUrl)}` })
  }
  res.status(502).json({ error: 'all sources failed', detail: errors })
}))

// ---- lyric / pic ----
app.post('/api/lyric', auth.requireAuth, wrap(async (req, res) => {
  const { musicInfo } = req.body || {}
  if (!musicInfo || !musicInfo.source) return res.status(400).json({ error: 'musicInfo required' })
  const sdk = musicSdk[musicInfo.source]
  if (!sdk || !sdk.getLyric) return res.status(400).json({ error: 'lyric unsupported for ' + musicInfo.source })
  const lyric = await sdk.getLyric(musicInfo)
  res.json(typeof lyric === 'string' ? { lyric } : lyric)
}))

app.post('/api/pic', auth.requireAuth, wrap(async (req, res) => {
  const { musicInfo } = req.body || {}
  if (!musicInfo || !musicInfo.source) return res.status(400).json({ error: 'musicInfo required' })
  const sdk = musicSdk[musicInfo.source]
  if (!sdk || !sdk.getPic) return res.status(400).json({ error: 'pic unsupported' })
  const pic = await sdk.getPic(musicInfo)
  res.json({ pic })
}))

// ---- image proxy (cover art) ----
// <img> can't send an Authorization header, so this accepts ?token= (attachUser
// reads it). Proxies http(s) cover images → avoids mixed-content under HTTPS.
app.get('/api/proxy/img', auth.requireAuth, (req, res) => {
  const target = req.query.url
  if (!target) return res.status(400).send('url required')
  let urlObj
  try { urlObj = new URL(target) } catch (e) { return res.status(400).send('bad url') }
  // only allow image hosts we expect, to avoid an open proxy
  if (!/\.(kugou|kuwo|qq|music\.126|126|migu)\.(com|cn|net)$/i.test(urlObj.hostname) && !/kugou|kuwo|qpic|migu|126/i.test(urlObj.hostname)) {
    return res.status(403).send('host not allowed')
  }
  const lib = urlObj.protocol === 'https:' ? https : http
  const up = lib.request(urlObj, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
    if ([301, 302, 307, 308].includes(r.statusCode) && r.headers.location) {
      r.resume(); res.redirect('/api/proxy/img?token=' + encodeURIComponent(req.query.token || '') + '&url=' + encodeURIComponent(new URL(r.headers.location, urlObj).toString())); return
    }
    res.status(r.statusCode)
    if (r.headers['content-type']) res.setHeader('content-type', r.headers['content-type'])
    res.setHeader('cache-control', 'public, max-age=86400')
    r.pipe(res)
  })
  up.on('error', () => { if (!res.headersSent) res.status(502).end() })
  up.end()
})

// ---- audio proxy (adds headers, relays Range for seeking) ----
// Follows upstream redirects internally (third-party direct links often 302 to a
// CDN) so the browser always talks only to us — avoids CORS/Referer issues.
app.get('/api/proxy/audio', auth.requireAuth, (req, res) => {
  const target = req.query.url
  if (!target) return res.status(400).send('url required')

  const range = req.headers.range
  const referer = req.query.referer ? String(req.query.referer) : null

  const stream = (urlStr, redirectsLeft) => {
    let urlObj
    try { urlObj = new URL(urlStr) } catch (e) { if (!res.headersSent) res.status(400).send('bad url'); return }
    const lib = urlObj.protocol === 'https:' ? https : http
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    }
    if (referer) headers.Referer = referer
    if (range) headers.Range = range

    const upstream = lib.request(urlObj, { headers, method: 'GET' }, (up) => {
      if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
        up.resume() // drain
        if (redirectsLeft <= 0) { if (!res.headersSent) res.status(502).send('too many redirects'); return }
        return stream(new URL(up.headers.location, urlObj).toString(), redirectsLeft - 1)
      }
      res.status(up.statusCode)
      for (const h of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
        if (up.headers[h]) res.setHeader(h, up.headers[h])
      }
      if (!up.headers['content-type']) res.setHeader('content-type', 'audio/mpeg')
      up.pipe(res)
    })
    upstream.on('error', (e) => { if (!res.headersSent) res.status(502).send('proxy error: ' + e.message) })
    req.on('close', () => upstream.destroy())
    upstream.end()
  }

  stream(target, 5)
})

// ---- static frontend ----
// no-cache on all assets: the browser keeps an ETag and revalidates each load
// (cheap 304s), so an updated app.js/style.css is never paired with a stale one
// from memory cache — which would mismatch index.html and break rendering.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }))
app.get('*', (req, res) => {
  res.set('Cache-Control', 'no-cache')
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

// ---- start ----
sources.loadAll()
charts.start() // load cached charts + schedule periodic refresh
app.listen(PORT, HOST, () => {
  console.log(`\n  web-music server  →  http://${HOST}:${PORT}`)
  console.log(`  source dir: ${sources.SOURCE_DIR}`)
  console.log(`  sources: ${sources.list().map(s => s.id + (s.ready ? '' : '(x)')).join(', ') || '(none)'}`)
  console.log(`  search platforms: ${Object.keys(musicSdk).join(', ') || '(none)'}\n`)
})
