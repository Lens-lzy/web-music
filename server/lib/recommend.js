'use strict'
// 个性化推荐：基于用户的歌单 + 近 7 天播放历史，提取偏好歌手，
// 搜这些歌手的歌、混入榜单池，加权随机生成推荐。
//
//  - 每日推荐：30 首，按「以早 6 点为界的日期」缓存，过了 6 点首次访问自动重算。
//  - 因为你喜欢 XX：取偏好最高的 1~2 个歌手，各给一张小卡。
//  - 随便听听：喜好加权随机 30 首，每次调用都重算（手动换一批）。
//
// 数据源：酷狗（搜索 + 榜单缓存池）。无个人数据时回落到纯榜单随机。

const store = require('./store')
const charts = require('./charts')
const kg = require('../musicSdk/kg')

const songKey = (s) => (s.source || '') + ':' + (s.songmid || s.songId || (s.name + s.singer))

// 把 "周杰伦、方文山" 这类拆成单个歌手
const splitSingers = (str) => String(str || '').split(/[、,&/]/).map(x => x.trim()).filter(Boolean)

// 统计用户的歌手偏好权重：歌单里的歌权重高(3)，历史里的按次数(1)。
const buildTasteProfile = (userId, now) => {
  const weights = new Map() // singer -> weight
  const seenKeys = new Set() // 用户已有的歌，用于推荐时排除
  const bump = (singer, w) => { if (!singer) return; weights.set(singer, (weights.get(singer) || 0) + w) }

  for (const s of store.getAllSongs(userId)) {
    seenKeys.add(songKey(s))
    for (const sg of splitSingers(s.singer)) bump(sg, 3)
  }
  for (const e of store.getHistory(userId, now)) {
    seenKeys.add(songKey(e))
    for (const sg of splitSingers(e.singer)) bump(sg, 1)
  }
  // 排序歌手
  const singers = [...weights.entries()].sort((a, b) => b[1] - a[1]).map(([name, w]) => ({ name, w }))
  return { singers, seenKeys }
}

// Fisher-Yates 洗牌
const shuffle = (arr) => {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// 从榜单缓存里汇总一个"候选池"
const chartPool = () => {
  const pool = []
  const f = charts.get()
  for (const card of (f.cards || [])) for (const s of card.songs) pool.push(s)
  return pool
}

// 搜索某歌手的歌（容错：失败返回空）
const searchSinger = async (name, limit = 20) => {
  try { const r = await kg.search(name, 1, limit); return r.list || [] } catch (e) { return [] }
}

const dedupePush = (out, seen, song) => {
  const k = songKey(song)
  if (seen.has(k)) return false
  seen.add(k); out.push(song); return true
}

// ---- 每日推荐：30 首 ----
const buildDaily = async (userId, now) => {
  const { singers, seenKeys } = buildTasteProfile(userId, now)
  const out = []
  const seen = new Set(seenKeys) // 排除用户已有的歌

  // 1) 取偏好 top 歌手，搜他们的歌
  const topSingers = singers.slice(0, 6)
  for (const sg of topSingers) {
    const songs = shuffle(await searchSinger(sg.name, 20)).slice(0, 6)
    for (const s of songs) { dedupePush(out, seen, s); if (out.length >= 30) break }
    if (out.length >= 30) break
  }

  // 2) 不足 30：用榜单池补足（加权随机）
  if (out.length < 30) {
    for (const s of shuffle(chartPool())) {
      dedupePush(out, seen, s)
      if (out.length >= 30) break
    }
  }
  return out.slice(0, 30)
}

// ---- 因为你喜欢 XX：每个 top 歌手一张卡（最多 2 张）----
const buildBecauseYouLike = async (singers) => {
  const cards = []
  for (const sg of singers.slice(0, 2)) {
    const songs = await searchSinger(sg.name, 12)
    if (songs.length) cards.push({ key: 'byl_' + sg.name, title: `因为你喜欢 ${sg.name}`, desc: '根据你的口味', source: 'kg', songs: songs.slice(0, 10) })
  }
  return cards
}

// ---- 随便听听：喜好加权随机 30 首（每次都重算）----
const buildShuffle = async (userId, now) => {
  const { singers, seenKeys } = buildTasteProfile(userId, now)
  const out = []
  const seen = new Set()

  // 60% 来自偏好歌手，40% 来自榜单池；都随机。新用户无歌手 → 全榜单。
  if (singers.length) {
    const picks = shuffle(singers).slice(0, 8) // 随机挑几个偏好歌手（不总是 top，增加新鲜感）
    for (const sg of picks) {
      const songs = shuffle(await searchSinger(sg.name, 15)).slice(0, 4)
      for (const s of songs) { dedupePush(out, seen, s); if (out.length >= 18) break }
      if (out.length >= 18) break
    }
  }
  for (const s of shuffle(chartPool())) {
    dedupePush(out, seen, s)
    if (out.length >= 30) break
  }
  return shuffle(out).slice(0, 30)
}

// 以早 6 点为界的"推荐日"标识：今天 6 点前算前一天。
const recDay = (now) => {
  const d = new Date(now - 6 * 3600000) // 减 6 小时，使 06:00 成为日界
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// 每日推荐缓存：{ userId: { day, daily:[...], cards:[...] } }
const dailyCache = new Map()

// 公开：获取个性化推荐（每日推荐 + 因为你喜欢卡片），按 recDay 缓存。
// force=true 时忽略缓存强制重算（手动刷新）。
const getRecommend = async (userId, now, force = false) => {
  const day = recDay(now)
  const cached = dailyCache.get(userId)
  if (!force && cached && cached.day === day) return { day, daily: cached.daily, cards: cached.cards }

  const { singers } = buildTasteProfile(userId, now)
  const daily = await buildDaily(userId, now)
  const cards = await buildBecauseYouLike(singers)
  const result = { day, daily, cards }
  dailyCache.set(userId, result)
  return result
}

const getShuffle = (userId, now) => buildShuffle(userId, now)

module.exports = { getRecommend, getShuffle, recDay }
