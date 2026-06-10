'use strict'
// 轻量翻译：默认用 Google 免费端点（translate.googleapis.com，无需 key），失败时短文本回退
// MyMemory。长文本自动分块（Google 会保留 \n 段落结构）。任何失败都「优雅返回原文」。
//
// 配置：PF_NEWS_TRANSLATE_LANG（目标语言，默认 zh-CN）。
// 注意：Google 免费端点是非官方接口，可能被限流；news.js 已做「只翻新条目 + 缓存」把调用量压到最低。

const { requestAsync } = require('./request')

const DEFAULT_TARGET = process.env.PF_NEWS_TRANSLATE_LANG || 'zh-CN'
// 块小一点更稳（更短的 q 不易被免费端点拒；且 <480 的块能用 MyMemory 兜底）
const MAX_CHUNK = 450

const googleOnce = async (text, target) => {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(text)
  const resp = await requestAsync(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!resp || resp.statusCode >= 400) throw new Error('google HTTP ' + (resp && resp.statusCode))
  const data = typeof resp.body === 'object' ? resp.body : JSON.parse(resp.body)
  const out = (data[0] || []).map(seg => seg[0]).join('')
  if (!out) throw new Error('google empty')
  return out
}

const myMemoryOnce = async (text, target) => {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=en|' + encodeURIComponent(target)
  const resp = await requestAsync(url, { timeout: 12000 })
  const data = typeof resp.body === 'object' ? resp.body : JSON.parse(resp.body)
  const out = data && data.responseData && data.responseData.translatedText
  if (!out) throw new Error('mymemory empty')
  return out
}

// 按段落/句子边界切块，尽量保留 \n（Google 会保留换行→段落结构不丢）
const chunk = (text, max = MAX_CHUNK) => {
  if (text.length <= max) return [text]
  const parts = []
  let buf = ''
  for (const piece of text.split(/(\n+|(?<=[.!?。！？])\s+)/)) {
    if (piece == null) continue
    if (buf && (buf + piece).length > max) { parts.push(buf); buf = '' }
    buf += piece
    while (buf.length > max) { parts.push(buf.slice(0, max)); buf = buf.slice(max) }
  }
  if (buf) parts.push(buf)
  return parts
}

const googleWithRetry = async (text, target) => {
  try { return await googleOnce(text, target) }
  catch (_) { return await googleOnce(text, target) } // 1 次重试
}

// 翻译一段文本；长文自动分块。**逐块兜底**：某块失败先重试、再 MyMemory（短块）、
// 都不行就保留该块原文——避免「一块失败拖垮整段→整段回退英文」。
const translate = async (text, { target = DEFAULT_TARGET } = {}) => {
  const t = (text || '').trim()
  if (!t) return text
  const parts = chunk(t)
  const out = []
  for (const p of parts) {
    try {
      out.push(await googleWithRetry(p, target))
    } catch (_) {
      if (p.length < 480) {
        try { out.push(await myMemoryOnce(p, target)); continue } catch (__) {}
      }
      out.push(p) // 该块保留原文，不影响其它块
    }
  }
  return out.join('')
}

module.exports = { translate }
