'use strict'
// Tiny JSON-file user store. No external deps. Persists to data/users.json
// (override dir with WEB_MUSIC_DATA_DIR). On first run it seeds a super-admin
// account from WEB_MUSIC_ADMIN_USER / WEB_MUSIC_ADMIN_PASSWORD, falling back to
// admin / password for local development.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DATA_DIR = process.env.WEB_MUSIC_DATA_DIR || path.resolve(__dirname, '..', '..', 'data')
const INITIAL_ADMIN_USER = process.env.WEB_MUSIC_ADMIN_USER || 'admin'
const INITIAL_ADMIN_PASSWORD = process.env.WEB_MUSIC_ADMIN_PASSWORD || 'password'
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json') // legacy, auto-migrated
const PLAYLISTS_FILE = path.join(DATA_DIR, 'playlists.json')
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')
const HISTORY_FILE = path.join(DATA_DIR, 'history.json')
const SEARCH_HISTORY_FILE = path.join(DATA_DIR, 'search_history.json')

const ensureDir = () => { try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (_) {} }

// scrypt password hashing -> "scrypt$<saltHex>$<hashHex>"
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
const verifyPassword = (password, stored) => {
  if (typeof stored !== 'string') return false
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected)
}

let db = null // { users: [...], nextId }

const load = () => {
  if (db) return db
  ensureDir()
  if (fs.existsSync(USERS_FILE)) {
    try { db = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch (e) { db = null }
  }
  if (!db || !Array.isArray(db.users)) {
    db = { nextId: 1, users: [] }
  }
  // seed default super admin
  if (!db.users.length) {
    db.users.push({
      id: db.nextId++,
      username: INITIAL_ADMIN_USER,
      passwordHash: hashPassword(INITIAL_ADMIN_PASSWORD),
      isAdmin: true,
      mustChangePassword: true,
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    })
    save()
    const source = process.env.WEB_MUSIC_ADMIN_PASSWORD ? 'WEB_MUSIC_ADMIN_PASSWORD' : 'development default password'
    console.log(`[store] seeded default super-admin: ${INITIAL_ADMIN_USER} (${source}; please change it)`)
  }
  return db
}

const save = () => {
  ensureDir()
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2))
}

// ---- public shape (never leak passwordHash) ----
const publicUser = (u) => u && ({
  id: u.id, username: u.username, isAdmin: !!u.isAdmin,
  mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt,
})

const listUsers = () => load().users.map(publicUser)
const findById = (id) => load().users.find(u => u.id === Number(id))
const findByUsername = (name) => load().users.find(u => u.username.toLowerCase() === String(name).toLowerCase())

const createUser = ({ username, password, isAdmin = false }) => {
  load()
  username = String(username || '').trim()
  if (!username) throw new Error('用户名不能为空')
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位')
  if (findByUsername(username)) throw new Error('用户名已存在')
  const user = {
    id: db.nextId++,
    username,
    passwordHash: hashPassword(password),
    isAdmin: !!isAdmin,
    mustChangePassword: false,
    createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  db.users.push(user)
  save()
  return publicUser(user)
}

const deleteUser = (id) => {
  load()
  id = Number(id)
  const u = findById(id)
  if (!u) throw new Error('用户不存在')
  if (u.isAdmin && db.users.filter(x => x.isAdmin).length <= 1) {
    throw new Error('不能删除最后一个管理员')
  }
  db.users = db.users.filter(x => x.id !== id)
  save()
  deleteUserPlaylists(id) // clean up the removed user's playlists
  deleteQueue(id)         // and their saved play queue
  deleteHistory(id)       // and their play history
  deleteSearchHistory(id) // and their search history
  return true
}

const setPassword = (id, newPassword) => {
  load()
  const u = findById(id)
  if (!u) throw new Error('用户不存在')
  if (!newPassword || String(newPassword).length < 4) throw new Error('密码至少 4 位')
  u.passwordHash = hashPassword(newPassword)
  u.mustChangePassword = false
  save()
  return true
}

const setAdmin = (id, isAdmin) => {
  load()
  const u = findById(id)
  if (!u) throw new Error('用户不存在')
  if (u.isAdmin && !isAdmin && db.users.filter(x => x.isAdmin).length <= 1) {
    throw new Error('不能取消最后一个管理员的权限')
  }
  u.isAdmin = !!isAdmin
  save()
  return publicUser(u)
}

const authenticate = (username, password) => {
  load()
  const u = findByUsername(username)
  if (!u) return null
  if (!verifyPassword(password, u.passwordHash)) return null
  return u
}

// =====================================================================
//  Per-user playlists. Keyed by userId so accounts never share data.
//  Persisted to playlists.json as:
//    { "<userId>": { nextId, lists: [ {id,name,isDefault,songs:[],createdAt} ] } }
//  Every user always has a default, non-deletable "我喜欢的" playlist.
//  Legacy favorites.json (a flat { userId: [songs] }) is auto-migrated on first
//  access into that user's default playlist.
// =====================================================================
const DEFAULT_NAME = '我喜欢的'
let plDb = null
let legacyFav = null

const loadLegacyFav = () => {
  if (legacyFav !== null) return legacyFav
  legacyFav = {}
  if (fs.existsSync(FAVORITES_FILE)) {
    try { legacyFav = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')) || {} } catch (e) { legacyFav = {} }
  }
  return legacyFav
}

const loadPl = () => {
  if (plDb) return plDb
  ensureDir()
  if (fs.existsSync(PLAYLISTS_FILE)) {
    try { plDb = JSON.parse(fs.readFileSync(PLAYLISTS_FILE, 'utf8')) } catch (e) { plDb = null }
  }
  if (!plDb || typeof plDb !== 'object') plDb = {}
  return plDb
}
const savePl = () => {
  ensureDir()
  fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(plDb))
}

// Ensure a user's playlist container exists, with a default playlist. Migrates
// legacy favorites into the default playlist the first time.
const ensureUserPl = (userId) => {
  loadPl()
  const key = String(userId)
  if (!plDb[key]) {
    const legacy = loadLegacyFav()[key]
    const defaultSongs = Array.isArray(legacy) ? legacy : []
    plDb[key] = {
      nextId: 2,
      lists: [{ id: 1, name: DEFAULT_NAME, isDefault: true, songs: defaultSongs, createdAt: nowStr() }],
    }
    savePl()
  }
  return plDb[key]
}

const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

// public shape — songs count instead of full songs for list view
const playlistMeta = (p) => ({ id: p.id, name: p.name, isDefault: !!p.isDefault, count: p.songs.length, createdAt: p.createdAt })

const getPlaylists = (userId) => ensureUserPl(userId).lists.map(playlistMeta)

const getPlaylist = (userId, playlistId) => {
  const c = ensureUserPl(userId)
  const p = c.lists.find(x => x.id === Number(playlistId))
  if (!p) throw new Error('歌单不存在')
  return { id: p.id, name: p.name, isDefault: !!p.isDefault, createdAt: p.createdAt, songs: p.songs }
}

const createPlaylist = (userId, name) => {
  const c = ensureUserPl(userId)
  name = String(name || '').trim()
  if (!name) throw new Error('歌单名不能为空')
  if (c.lists.some(p => p.name === name)) throw new Error('已存在同名歌单')
  const p = { id: c.nextId++, name, isDefault: false, songs: [], createdAt: nowStr() }
  c.lists.push(p)
  savePl()
  return playlistMeta(p)
}

const deletePlaylist = (userId, playlistId) => {
  const c = ensureUserPl(userId)
  const p = c.lists.find(x => x.id === Number(playlistId))
  if (!p) throw new Error('歌单不存在')
  if (p.isDefault) throw new Error('默认歌单不可删除')
  c.lists = c.lists.filter(x => x.id !== Number(playlistId))
  savePl()
  return true
}

const renamePlaylist = (userId, playlistId, name) => {
  const c = ensureUserPl(userId)
  const p = c.lists.find(x => x.id === Number(playlistId))
  if (!p) throw new Error('歌单不存在')
  if (p.isDefault) throw new Error('默认歌单不可重命名')
  name = String(name || '').trim()
  if (!name) throw new Error('歌单名不能为空')
  if (c.lists.some(x => x.name === name && x.id !== p.id)) throw new Error('已存在同名歌单')
  p.name = name
  savePl()
  return playlistMeta(p)
}

const songKey = (s) => (s.source || '') + ':' + (s.songmid || s.songId || (s.name + s.singer))

const addToPlaylist = (userId, playlistId, song) => {
  const c = ensureUserPl(userId)
  const p = c.lists.find(x => x.id === Number(playlistId))
  if (!p) throw new Error('歌单不存在')
  if (!song || !song.source) throw new Error('歌曲信息无效')
  if (!p.songs.some(s => songKey(s) === songKey(song))) {
    p.songs.push(song)
    if (p.songs.length > 5000) p.songs = p.songs.slice(-5000)
    savePl()
  }
  return { id: p.id, count: p.songs.length }
}

const removeFromPlaylist = (userId, playlistId, key) => {
  const c = ensureUserPl(userId)
  const p = c.lists.find(x => x.id === Number(playlistId))
  if (!p) throw new Error('歌单不存在')
  p.songs = p.songs.filter(s => songKey(s) !== key)
  savePl()
  return { id: p.id, count: p.songs.length }
}

const deleteUserPlaylists = (userId) => {
  loadPl()
  delete plDb[String(userId)]
  savePl()
}

// =====================================================================
//  Per-user play queue (persisted so a refresh keeps the playlist).
//  queue.json: { "<userId>": { songs: [...], idx: <number> } }
// =====================================================================
let qDb = null
const loadQ = () => {
  if (qDb) return qDb
  ensureDir()
  if (fs.existsSync(QUEUE_FILE)) {
    try { qDb = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) } catch (e) { qDb = null }
  }
  if (!qDb || typeof qDb !== 'object') qDb = {}
  return qDb
}
const saveQ = () => { ensureDir(); fs.writeFileSync(QUEUE_FILE, JSON.stringify(qDb)) }
const getQueue = (userId) => {
  loadQ()
  const q = qDb[String(userId)]
  return q && Array.isArray(q.songs) ? { songs: q.songs, idx: Number(q.idx) || 0 } : { songs: [], idx: -1 }
}
const setQueue = (userId, songs, idx) => {
  loadQ()
  if (!Array.isArray(songs)) throw new Error('queue must be an array')
  qDb[String(userId)] = { songs: songs.slice(0, 2000), idx: Number(idx) }
  saveQ()
  return getQueue(userId)
}
const deleteQueue = (userId) => { loadQ(); delete qDb[String(userId)]; saveQ() }

// =====================================================================
//  Per-user play history (last 7 days). Drives personalised recommends.
//  history.json: { "<userId>": [ { ...song, playedAt: <ms> } ] }  (newest last)
// =====================================================================
const HISTORY_DAYS = 7
let hDb = null
const loadH = () => {
  if (hDb) return hDb
  ensureDir()
  if (fs.existsSync(HISTORY_FILE)) {
    try { hDb = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) } catch (e) { hDb = null }
  }
  if (!hDb || typeof hDb !== 'object') hDb = {}
  return hDb
}
const saveH = () => { ensureDir(); fs.writeFileSync(HISTORY_FILE, JSON.stringify(hDb)) }
// record a play; prunes entries older than 7 days. now = Date.now() passed in by caller.
const addHistory = (userId, song, now) => {
  loadH()
  if (!song || !song.source) return
  const key = String(userId)
  const cutoff = now - HISTORY_DAYS * 86400000
  const arr = (hDb[key] || []).filter(e => e.playedAt >= cutoff)
  arr.push({ ...song, playedAt: now })
  if (arr.length > 2000) arr.splice(0, arr.length - 2000)
  hDb[key] = arr
  saveH()
}
const getHistory = (userId, now) => {
  loadH()
  const cutoff = now - HISTORY_DAYS * 86400000
  return (hDb[String(userId)] || []).filter(e => e.playedAt >= cutoff)
}
const deleteHistory = (userId) => { loadH(); delete hDb[String(userId)]; saveH() }

// =====================================================================
//  Per-user search history (keywords). Keeps the latest 10.
//  search_history.json: { "<userId>": ["周杰伦", ...] }  (newest first)
// =====================================================================
const SEARCH_MAX = 10
let shDb = null
const loadSH = () => {
  if (shDb) return shDb
  ensureDir()
  if (fs.existsSync(SEARCH_HISTORY_FILE)) {
    try { shDb = JSON.parse(fs.readFileSync(SEARCH_HISTORY_FILE, 'utf8')) } catch (e) { shDb = null }
  }
  if (!shDb || typeof shDb !== 'object') shDb = {}
  return shDb
}
const saveSH = () => { ensureDir(); fs.writeFileSync(SEARCH_HISTORY_FILE, JSON.stringify(shDb)) }
const getSearchHistory = (userId) => { loadSH(); return shDb[String(userId)] || [] }
const addSearchHistory = (userId, keyword) => {
  loadSH()
  keyword = String(keyword || '').trim()
  if (!keyword) return getSearchHistory(userId)
  const key = String(userId)
  const arr = (shDb[key] || []).filter(k => k !== keyword) // 去重，移到最前
  arr.unshift(keyword)
  shDb[key] = arr.slice(0, SEARCH_MAX)
  saveSH()
  return shDb[key]
}
const removeSearchHistory = (userId, keyword) => {
  loadSH()
  const key = String(userId)
  shDb[key] = (shDb[key] || []).filter(k => k !== keyword)
  saveSH()
  return shDb[key]
}
const clearSearchHistory = (userId) => { loadSH(); shDb[String(userId)] = []; saveSH() }
const deleteSearchHistory = (userId) => { loadSH(); delete shDb[String(userId)]; saveSH() }

// All songs the user has in any playlist (used as a taste signal for recommends).
const getAllSongs = (userId) => {
  const c = ensureUserPl(userId)
  const out = []
  for (const p of c.lists) for (const s of p.songs) out.push(s)
  return out
}

module.exports = {
  load, listUsers, findById, findByUsername,
  createUser, deleteUser, setPassword, setAdmin,
  authenticate, publicUser, verifyPassword, hashPassword,
  getPlaylists, getPlaylist, createPlaylist, deletePlaylist, renamePlaylist,
  addToPlaylist, removeFromPlaylist, deleteUserPlaylists, songKey, getAllSongs,
  getQueue, setQueue, deleteQueue,
  addHistory, getHistory, deleteHistory,
  getSearchHistory, addSearchHistory, removeSearchHistory, clearSearchHistory, deleteSearchHistory,
  DATA_DIR, USERS_FILE, FAVORITES_FILE, PLAYLISTS_FILE, QUEUE_FILE, HISTORY_FILE, SEARCH_HISTORY_FILE,
}
