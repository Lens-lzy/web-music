'use strict'
// 精选首页数据源：定时（默认每 12 小时）抓取酷狗热门榜单，分卡片缓存。
// 缓存落地到 data/charts.json，重启后先用旧缓存、后台再刷新，避免首页空白。
//
// 备注：当前仅接酷狗（本环境唯一稳定可达的源）。每个卡片对应一个酷狗榜单 id。
// 卡片标题做了"语义化"命名（最热华语/最热英文/最新发布…）。后续若 QQ/网易
// 接口在你的服务器可达，可在 CARDS 里加来源。

const fs = require('node:fs')
const path = require('node:path')
const kg = require('../musicSdk/kg')

const DATA_DIR = process.env.WEB_MUSIC_DATA_DIR || path.resolve(__dirname, '..', '..', 'data')
const CACHE_FILE = path.join(DATA_DIR, 'charts.json')
const REFRESH_MS = Number(process.env.CHARTS_REFRESH_MS) || 12 * 3600 * 1000 // 12h
const SONGS_PER_CARD = Number(process.env.CHARTS_CARD_SIZE) || 50

// 卡片定义：标题 + 酷狗榜单 id（bangid）
const CARDS = [
  { key: 'hot_cn',  title: '最热华语', source: 'kg', bangid: '8888',  desc: '酷狗 TOP50' },
  { key: 'rising',  title: '飙升榜',   source: 'kg', bangid: '6666',  desc: '近期上升最快' },
  { key: 'hot_en',  title: '最热欧美', source: 'kg', bangid: '31310', desc: '欧美热歌' },
  { key: 'new',     title: '最新发布', source: 'kg', bangid: '31308', desc: '华语新歌榜' },
  { key: 'tiktok',  title: '抖音热歌', source: 'kg', bangid: '52144', desc: '短视频热歌' },
  { key: 'cantonese', title: '粤语金曲', source: 'kg', bangid: '33165', desc: '粤语热门' },
]

let cache = { updatedAt: 0, cards: [] }
let refreshing = false

const loadCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      if (d && Array.isArray(d.cards)) cache = d
    }
  } catch (_) {}
  return cache
}
const saveCache = () => {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (_) {}
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)) } catch (_) {}
}

// fetch one card; returns {key,title,desc,source,songs} or null on failure
const fetchCard = async (c) => {
  try {
    const r = await kg.getLeaderboard(c.bangid, SONGS_PER_CARD)
    if (!r.list || !r.list.length) return null
    return { key: c.key, title: c.title, desc: c.desc, source: c.source, songs: r.list }
  } catch (e) {
    console.error(`[charts] card "${c.key}" fetch failed: ${e.message}`)
    return null
  }
}

const refresh = async () => {
  if (refreshing) return
  refreshing = true
  try {
    const cards = []
    for (const c of CARDS) {
      const card = await fetchCard(c)
      if (card) cards.push(card)
    }
    if (cards.length) {
      // stamp time outside the workflow-restricted Date ban (this is plain server runtime)
      cache = { updatedAt: Date.now(), cards }
      saveCache()
      console.log(`[charts] refreshed ${cards.length}/${CARDS.length} cards`)
    } else {
      console.warn('[charts] refresh produced no cards (sources unreachable?)')
    }
  } finally {
    refreshing = false
  }
}

// public: current cards (may be empty before first successful fetch)
const get = () => ({ updatedAt: cache.updatedAt, cards: cache.cards })

// kick off: load disk cache (shown immediately), ALWAYS refresh in background on boot,
// then schedule every REFRESH_MS. 后台刷新保证改了 SONGS_PER_CARD / 卡片定义后，
// 重启即生效，无需手动删 data/charts.json（旧缓存只在刷新完成前临时顶上）。
const start = () => {
  loadCache()
  refresh() // fire-and-forget; serves old cache until the fresh fetch lands
  setInterval(refresh, REFRESH_MS)
}

module.exports = { start, get, refresh, CARDS }
