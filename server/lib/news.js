'use strict'
// 音乐资讯源：定时抓取若干 RSS/Atom 源，解析成统一卡片缓存，供首页轮播使用。
// 设计与 charts.js 一致：开机先用磁盘旧缓存顶上，后台刷新；任一源失败只跳过该源，
// 全失败则返回空列表（客户端轮播自动隐藏，绝不白屏）。零第三方依赖——自带轻量解析器。
//
// 配置（都可选）：
//   PF_NEWS_FEEDS   完全自定义源列表，JSON：'[{"name":"豆瓣音乐","url":"https://..."}]'
//                   也支持逗号/换行分隔的 "名称|地址" 或纯 "地址"。
//   PF_RSSHUB_BASE  RSSHub 实例地址（默认公共 https://rsshub.app；建议自建后指向 http://localhost:1200）
//   NEWS_REFRESH_MS 刷新间隔（默认 30 分钟）
//   NEWS_MAX        缓存条数上限（默认 30）

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { requestAsync } = require('./request')
const { translate } = require('./translate')

// 翻译开关：默认开（把英文资讯翻成中文）；设 PF_NEWS_TRANSLATE=0 关闭。
const TRANSLATE = process.env.PF_NEWS_TRANSLATE !== '0'

const DATA_DIR = process.env.WEB_MUSIC_DATA_DIR || path.resolve(__dirname, '..', '..', 'data')
const CACHE_FILE = path.join(DATA_DIR, 'news.json')
const REFRESH_MS = Number(process.env.NEWS_REFRESH_MS) || 30 * 60 * 1000 // 30min
const NEWS_MAX = Number(process.env.NEWS_MAX) || 30

const RSSHUB = (process.env.PF_RSSHUB_BASE || 'https://rsshub.app').replace(/\/+$/, '')

// 解析 PF_NEWS_FEEDS（自定义源），失败回退到 DEFAULT_FEEDS。
const parseFeedsEnv = () => {
  const raw = process.env.PF_NEWS_FEEDS
  if (!raw || !raw.trim()) return null
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      const list = arr.filter(f => f && f.url).map(f => ({ name: String(f.name || f.url), url: String(f.url) }))
      if (list.length) return list
    }
  } catch (_) {
    const list = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map(s => {
      const i = s.indexOf('|')
      return i > 0 ? { name: s.slice(0, i).trim(), url: s.slice(i + 1).trim() } : { name: s, url: s }
    }).filter(f => /^https?:\/\//i.test(f.url))
    if (list.length) return list
  }
  return null
}

// 默认源：英文音乐资讯（直连、实测稳定，无需 RSSHub）。
// 说明：公共生态里几乎没有可用的「中文音乐」RSS——rsshub.app 国内连不上、社区镜像的
// 中文音乐路由普遍 503、中新网娱乐/文化频道已 404。要中文音乐内容只能自建 RSSHub，
// 或用 PF_NEWS_FEEDS 自定义。这里默认给最稳的英文音乐源（抓不到的会被静默跳过）。
const DEFAULT_FEEDS = [
  { name: 'Pitchfork', url: 'https://pitchfork.com/feed/feed-news/rss' },
  { name: 'NME', url: 'https://www.nme.com/news/music/feed' },
  { name: 'Billboard', url: 'https://www.billboard.com/feed/' },
]

const FEEDS = parseFeedsEnv() || DEFAULT_FEEDS

let cache = { updatedAt: 0, items: [] }
let refreshing = false

// ---- 轻量 XML 工具（够用即可，不追求完备） ----

// 单独剥掉 CDATA 标记但保留内部文本（必须早于去标签，否则 <![CDATA[..]]> 会被当成一个标签整体删掉）
const stripCdata = (s) => String(s == null ? '' : s).replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')

const decodeEntities = (s) => {
  if (s == null) return ''
  return stripCdata(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch (_) { return '' } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)) } catch (_) { return '' } })
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&') // 放最后，避免二次解码
}

// 先 decodeEntities（内部已剥 CDATA 标记，并把 &lt;b&gt; 这类实体还原成真标签），再统一去标签。
// 这样无论正文是 CDATA 包裹的真 HTML、还是实体编码的 HTML，都能干净地抽出纯文本。
const stripTags = (html) => decodeEntities(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// 整段删除 script/style/注释（否则去标签后里面的 JS/CSS 文本会漏成正文垃圾）
const stripDangerousBlocks = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '')

// 取首个匹配标签的内部内容（支持带命名空间的标签名，如 content:encoded）
const tagContent = (block, names) => {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i')
    const m = block.match(re)
    if (m) return m[1]
  }
  return ''
}

const attrOf = (block, tagNames, attr) => {
  for (const name of tagNames) {
    const re = new RegExp(`<${name}\\b[^>]*\\b${attr}\\s*=\\s*["']([^"']+)["']`, 'i')
    const m = block.match(re)
    if (m) return m[1]
  }
  return ''
}

// Atom <link href=.. rel=..>：优先 alternate，其次非 self/enclosure 的第一个
const atomLink = (block) => {
  const links = block.match(/<link\b[^>]*>/gi) || []
  let fallback = ''
  for (const l of links) {
    const href = (l.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1]
    if (!href) continue
    const rel = (l.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || 'alternate'
    if (rel === 'alternate') return href
    if (!fallback && rel !== 'self' && rel !== 'enclosure') fallback = href
  }
  return fallback
}

// 从单个 <img> 标签取 URL：优先懒加载属性（很多站点 src 是空占位、真图在 data-lazy-src）
const imgUrlFromTag = (tag) => {
  for (const attr of ['data-lazy-src', 'data-original', 'data-srcset', 'data-src', 'src']) {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i'))
    if (m && m[1].trim()) return m[1].trim().split(/\s+/)[0] // srcset 取第一个候选
  }
  return ''
}
const firstImg = (html) => {
  for (const tag of (html || '').match(/<img\b[^>]*>/gi) || []) {
    const u = imgUrlFromTag(tag)
    if (u) return u
  }
  return ''
}

// 剥掉常见的「降分辨率」查询参数，拿原图（feed 里的封面常被压成 23~237px 缩略图）
const RESIZE_PARAMS = new Set(['w', 'h', 'width', 'height', 'crop', 'fit', 'resize', 'quality', 'q', 'strip', 'ssl', 'zoom'])
const upgradeImage = (url) => {
  const i = (url || '').indexOf('?')
  if (i < 0) return url
  const kept = url.slice(i + 1).split('&').filter(p => !RESIZE_PARAMS.has(p.split('=')[0].toLowerCase()))
  return kept.length ? url.slice(0, i) + '?' + kept.join('&') : url.slice(0, i)
}

const extractCover = (block, contentHtml) => {
  const enc = block.match(/<enclosure\b[^>]*>/i)
  const encUrl = (enc && /image\//i.test(enc[0])) ? (enc[0].match(/\burl\s*=\s*["']([^"']+)["']/i) || [])[1] : ''
  // 优先大图来源；media:thumbnail 往往是小缩略图，放最后兜底
  const candidates = [
    attrOf(block, ['media:content'], 'url'),
    encUrl,
    firstImg(contentHtml),
    attrOf(block, ['media:thumbnail'], 'url'),
  ]
  for (const c of candidates) {
    if (c && c.trim()) return upgradeImage(decodeEntities(c).trim())
  }
  return ''
}

const idOf = (link, title) => crypto.createHash('sha1').update(String(link || '') + '|' + String(title || '')).digest('hex').slice(0, 16)

// 把一段 RSS/Atom XML 解析成统一条目数组
const parseFeed = (xml, sourceName) => {
  const out = []
  if (!xml || typeof xml !== 'string') return out
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml)
  const blocks = xml.match(isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) || []
  for (const block of blocks) {
    const title = stripTags(tagContent(block, ['title']))
    if (!title) continue
    const link = (isAtom ? atomLink(block) : stripTags(tagContent(block, ['link']))) || atomLink(block)
    const contentHtml = stripDangerousBlocks(decodeEntities(tagContent(block, ['content:encoded', 'content', 'description', 'summary'])))
    const cover = extractCover(block, contentHtml)
    let summary = stripTags(tagContent(block, ['description', 'summary']) || contentHtml)
    if (summary.length > 140) summary = summary.slice(0, 140) + '…'
    const dateStr = (tagContent(block, ['pubDate', 'published', 'updated', 'dc:date']) || '').trim()
    const pubDate = dateStr ? (Date.parse(decodeEntities(dateStr)) || 0) : 0
    out.push({ id: idOf(link, title), title, link, cover, summary, content: contentHtml, source: sourceName, pubDate })
  }
  return out
}

const fetchFeed = async (feed) => {
  try {
    const resp = await requestAsync(feed.url, {
      timeout: 20000,
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    })
    if (!resp || resp.statusCode >= 400) {
      console.error(`[news] "${feed.name}" HTTP ${resp && resp.statusCode}`)
      return []
    }
    const xml = typeof resp.body === 'string' ? resp.body : (resp.raw ? resp.raw.toString('utf8') : '')
    const items = parseFeed(xml, feed.name)
    console.log(`[news] "${feed.name}" → ${items.length} items`)
    return items
  } catch (e) {
    console.error(`[news] "${feed.name}" failed: ${e.message}`)
    return []
  }
}

const loadCache = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      if (d && Array.isArray(d.items)) cache = d
    }
  } catch (_) {}
  return cache
}
const saveCache = () => {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (_) {}
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)) } catch (_) {}
}

// HTML 正文 → 保留段落的纯文本（供翻译用）
const htmlToText = (html) => {
  let s = stripDangerousBlocks(decodeEntities(html || ''))
  s = s.replace(/<(?:br|p|div|li|h[1-6]|tr|blockquote)[^>]*>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  return s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

// 简单并发池
const mapPool = async (arr, n, fn) => {
  let i = 0
  const worker = async () => { while (i < arr.length) { const idx = i++; await fn(arr[idx], idx) } }
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, worker))
}

const refresh = async () => {
  if (refreshing) return
  refreshing = true
  try {
    const prev = new Map(cache.items.map(it => [it.id, it])) // 旧译文按 id 复用
    const all = []
    for (const feed of FEEDS) all.push(...await fetchFeed(feed))
    // 去重（按 id）+ 按时间倒序 + 截断
    const seen = new Set()
    const items = all
      .filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)))
      .sort((a, b) => (b.pubDate || 0) - (a.pubDate || 0))
      .slice(0, NEWS_MAX)
    // 复用上次的译文，避免重复翻译（把对 Google 的调用量压到「仅新条目」）
    for (const it of items) {
      const old = prev.get(it.id)
      if (old) { it.titleZh = old.titleZh; it.summaryZh = old.summaryZh; it.contentZh = old.contentZh }
    }
    // 仅给「还没译过标题」的新条目翻 标题+摘要（短、即时显示在轮播/预览）
    if (TRANSLATE) {
      const todo = items.filter(it => it.titleZh == null)
      if (todo.length) {
        await mapPool(todo, 5, async (it) => {
          it.titleZh = await translate(it.title, { allowMyMemory: true })
          if (it.summary) it.summaryZh = await translate(it.summary, { allowMyMemory: true })
        })
        console.log(`[news] translated ${todo.length} new items`)
      }
    }
    if (items.length) {
      cache = { updatedAt: Date.now(), items }
      saveCache()
      console.log(`[news] refreshed ${items.length} items from ${FEEDS.length} feeds`)
    } else {
      console.warn('[news] refresh produced no items (feeds unreachable / wrong routes?)')
    }
  } finally {
    refreshing = false
  }
}

// 按需翻译正文（详情接口首次访问时调用，结果缓存到该条目）
const ensureContentTranslated = async (item) => {
  if (!TRANSLATE || !item || item.contentZh != null) return
  let text = htmlToText(item.content || '')
  if (!text) { item.contentZh = ''; return }
  if (text.length > 6000) text = text.slice(0, 6000) // 兜底封顶，控调用量/时延
  item.contentZh = await translate(text)
}

// 列表：不含正文（content/contentZh 体积大，详情接口才给）
const get = () => ({ updatedAt: cache.updatedAt, items: cache.items.map(({ content, contentZh, ...rest }) => rest) })
// 详情：含 content
const getOne = (id) => cache.items.find(it => it.id === id) || null

// 图片代理白名单：只放行「当前资讯封面里出现过的图片域名」。
// 这样图片代理能转发英文源的封面，又不变成任意 URL 的开放代理。
const allowsImageHost = (host) => {
  if (!host) return false
  for (const it of cache.items) {
    if (!it.cover) continue
    try { if (new URL(it.cover).hostname === host) return true } catch (_) {}
  }
  return false
}

const start = () => {
  loadCache()
  refresh() // fire-and-forget；落地前先用磁盘旧缓存顶上
  setInterval(refresh, REFRESH_MS)
}

module.exports = { start, get, getOne, refresh, ensureContentTranslated, parseFeed, allowsImageHost, FEEDS }
