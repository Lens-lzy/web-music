'use strict'
// Kugou (kg) search / lyric / pic for the web-music backend.
//
// Field mapping follows lx-music's kg musicInfo shape
// (src/renderer/utils/musicSdk/kg/musicSearch.js), so the resulting object can
// be handed to a music-source script for URL resolution. A kg source reads
// `musicInfo.hash` (and the per-quality hash in `_types`) plus `songmid`.
//
// Uses the mobilecdn search endpoint (works without csrf token / cookie).
//
// musicInfo shape (one entry of search().list):
//   {
//     source:'kg', songmid:'<album_audio_id>', hash:'<128k FileHash>',
//     name, singer, albumName, albumId, interval:'mm:ss', _interval:<sec>,
//     img:null, lrc:null, otherSource:null,
//     types:[{type:'128k',size,hash},{type:'320k',...},{type:'flac',...}],
//     _types:{ '128k':{size,hash}, '320k':{...}, flac:{...} },
//     typeUrl:{},
//   }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const httpJson = async (url, headers = {}) => {
  const r = await fetch(url, { headers: Object.assign({ 'User-Agent': UA }, headers) })
  const txt = await r.text()
  try { return JSON.parse(txt) } catch (_) { return null }
}

const decodeName = (s = '') => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')

const fmtTime = (sec) => {
  sec = parseInt(sec) || 0
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
const sizeFormate = (size) => {
  if (!size) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++ }
  return size.toFixed(2) + units[i]
}

// Pull a cover URL straight from the list payload (no extra request).
//  - search items carry it in trans_param.union_cover
//  - rank items carry it in album_sizable_cover
// Both are "{size}" templates; ask for a concrete size.
const COVER_SIZE = 240
const extractCover = (it) => {
  let tpl = it.album_sizable_cover || (it.trans_param && it.trans_param.union_cover) || ''
  if (!tpl) return null
  return String(tpl).replace('{size}', COVER_SIZE)
}

// mobilecdn item -> lx kg musicInfo
const mapItem = (it) => {
  // singername may contain "歌手A、歌手B"
  const name = decodeName(it.songname || it.filename || '')
  const types = []
  const _types = {}
  if (it.hash && it.filesize) {
    const size = sizeFormate(it.filesize)
    types.push({ type: '128k', size, hash: it.hash })
    _types['128k'] = { size, hash: it.hash }
  } else if (it.hash) {
    types.push({ type: '128k', size: '', hash: it.hash })
    _types['128k'] = { size: '', hash: it.hash }
  }
  if (it['320hash'] && it['320hash'] !== '0' && /[a-f0-9]{32}/i.test(it['320hash'])) {
    const size = sizeFormate(it['320filesize'])
    types.push({ type: '320k', size, hash: it['320hash'] })
    _types['320k'] = { size, hash: it['320hash'] }
  }
  if (it.sqhash && it.sqhash !== '0' && /[a-f0-9]{32}/i.test(it.sqhash)) {
    const size = sizeFormate(it.sqfilesize)
    types.push({ type: 'flac', size, hash: it.sqhash })
    _types.flac = { size, hash: it.sqhash }
  }
  return {
    source: 'kg',
    songmid: String(it.album_audio_id || it.audio_id || ''),
    hash: it.hash,
    name,
    singer: decodeName(it.singername || ''),
    albumName: decodeName(it.album_name || ''),
    albumId: String(it.album_id || ''),
    interval: fmtTime(it.duration),
    _interval: parseInt(it.duration) || 0,
    img: extractCover(it),
    lrc: null,
    otherSource: null,
    types,
    _types,
    typeUrl: {},
  }
}

const search = async (keyword, page = 1, limit = 30) => {
  const url = `http://mobilecdn.kugou.com/api/v3/search/song?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=${limit}&showtype=1`
  const j = await httpJson(url)
  if (!j || j.status !== 1) throw new Error('kugou search failed')
  const info = (j.data && j.data.info) || []
  const list = info.map(mapItem).filter(m => m.hash)
  const total = (j.data && j.data.total) || list.length
  return { list, total, page, limit, allPage: Math.ceil(total / limit), source: 'kg' }
}

// lyric + pic via the kugou mobile song detail endpoint
const _detail = async (hash) => {
  const j = await httpJson(`http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`, { Referer: 'http://m.kugou.com/' })
  return j || {}
}

// Kugou lyric search -> download (krc/lrc). Returns { lyric }.
const getLyric = async (musicInfo) => {
  const hash = musicInfo.hash
  if (!hash) throw new Error('missing hash')
  // 1) search candidate
  const s = await httpJson(`http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&hash=${encodeURIComponent(hash)}`)
  const cand = s && s.candidates && s.candidates[0]
  if (!cand) return { lyric: '' }
  // 2) download as plain lrc
  const d = await httpJson(`http://lyrics.kugou.com/download?ver=1&client=pc&fmt=lrc&charset=utf8&id=${cand.id}&accesskey=${cand.accesskey}`)
  if (!d || !d.content) return { lyric: '' }
  const lyric = Buffer.from(d.content, 'base64').toString('utf8')
  return { lyric }
}

const getPic = async (musicInfo) => {
  const d = await _detail(musicInfo.hash)
  const img = d.imgUrl || d.album_img || ''
  // kugou returns templates like ".../{size}/..." — request a concrete size
  return img ? String(img).replace('{size}', '400') : ''
}

// map a leaderboard item to lx kg musicInfo shape
const mapRankItem = (it) => {
  const types = []
  const _types = {}
  if (it.hash) { types.push({ type: '128k', size: sizeFormate(it.filesize), hash: it.hash }); _types['128k'] = { size: '', hash: it.hash } }
  if (it['320hash'] && /[a-f0-9]{32}/i.test(it['320hash'])) { types.push({ type: '320k', size: '', hash: it['320hash'] }); _types['320k'] = { size: '', hash: it['320hash'] } }
  if (it.sqhash && /[a-f0-9]{32}/i.test(it.sqhash)) { types.push({ type: 'flac', size: '', hash: it.sqhash }); _types.flac = { size: '', hash: it.sqhash } }
  return {
    source: 'kg',
    songmid: String(it.album_audio_id || it.audio_id || ''),
    hash: it.hash,
    name: decodeName(it.songname || it.filename || ''),
    singer: (it.authors || []).map(a => a.author_name).join('、') || decodeName(it.singername || ''),
    albumName: decodeName(it.remark || it.album_name || ''),
    albumId: String(it.album_id || ''),
    interval: fmtTime(it.duration),
    _interval: parseInt(it.duration) || 0,
    img: extractCover(it), lrc: null, otherSource: null,
    types, _types, typeUrl: {},
  }
}

// Fetch a kugou leaderboard by its rank id (bangid). Returns up to `limit` songs.
const getLeaderboard = async (bangid, limit = 30) => {
  const url = `http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=${limit}&area_code=1&page=1&rankid=${encodeURIComponent(bangid)}&with_res_tag=0&show_portrait_mv=1`
  const j = await httpJson(url)
  if (!j || j.errcode !== 0 || !j.data) throw new Error('kugou rank failed')
  const list = (j.data.info || []).map(mapRankItem).filter(m => m.hash)
  return { list, total: j.data.total || list.length, source: 'kg', bangid }
}

module.exports = { search, getLyric, getPic, getLeaderboard }
