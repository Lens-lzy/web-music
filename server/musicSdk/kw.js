'use strict'

/*
 * ============================================================================
 *  Kuwo (kw) music SDK — standalone Node.js (CommonJS) port of lx-music-desktop
 * ============================================================================
 *
 *  Ported from lx-music-desktop:
 *    src/renderer/utils/musicSdk/kw/{index,musicSearch,lyric,pic,util}.js
 *    src/renderer/utils/request.js                          (httpFetch contract)
 *    src/renderer/utils/index.ts                            (decodeName/formatPlayTime)
 *    src/main/modules/winMain/rendererEvent/kw_decodeLyric.ts (lyric decode)
 *
 *  Runs on plain Node 18+ using the global `fetch`. No Electron, no browser, no
 *  app-internal request helper, and ZERO hard npm dependencies.
 *
 *  Exports (CommonJS):
 *    async search(keyword, page = 1, limit = 30)
 *        -> { list, total, page, limit, allPage, source:'kw' }
 *    async getLyric(musicInfo)
 *        -> { lyric, tlyric, lxlyric }
 *    async getPic(musicInfo)
 *        -> album-art URL string (or null)
 *
 * ----------------------------------------------------------------------------
 *  EXACT musicInfo SHAPE produced by search() (one entry of `list`)
 * ----------------------------------------------------------------------------
 *  This is the SAME native shape lx-music's kw musicSearch.handleResult emits.
 *  Keep these field names — a downstream music-source script consumes this object.
 *
 *  {
 *    name:        '晴天',                // song title (HTML-entity decoded)
 *    singer:      '周杰伦、方文山',       // artist(s); raw '&' separator -> '、'
 *    source:      'kw',                 // always 'kw'
 *    songmid:     '188911',             // Kuwo rid (STRING, no 'MUSIC_' prefix)
 *                                       //   -> the id used for url / lyric / pic
 *    albumId:     '5773',              // album id (string, may be '')
 *    interval:    '04:29',             // formatted play time "mm:ss" (string); 0 if NaN
 *    albumName:   '叶惠美',             // album name (decoded, may be '')
 *    lrc:         null,                // always null at search time
 *    img:         null,                // always null at search time (use getPic)
 *    otherSource: null,                // always null
 *    types: [                          // ASCENDING-quality list of available formats
 *      { type: '128k',      size: '3.86MB' },
 *      { type: '320k',      size: '9.7MB'  },
 *      { type: 'flac',      size: '23.8MB' },
 *      { type: 'flac24bit', size: '40MB'   },
 *    ],
 *    _types: {                         // same info keyed by quality, size upper-cased
 *      '128k':      { size: '3.86MB' },
 *      '320k':      { size: '9.7MB'  },
 *      flac:        { size: '23.8MB' },
 *      flac24bit:   { size: '40MB'   },
 *    },
 *    typeUrl: {},                      // empty; filled later when a play url is fetched
 *  }
 *
 * ----------------------------------------------------------------------------
 *  What a music-source script's musicUrl request needs
 * ----------------------------------------------------------------------------
 *  lx passes  { type: <quality>, musicInfo }  to the source.
 *    - type      : one of the KW quality strings (below)
 *    - musicInfo : the object above; the source reads `musicInfo.songmid`
 *                  (the Kuwo rid) to build the play-url request, and may read
 *                  name / singer / albumName / interval for matching.
 *
 *  KW quality / type strings used by lx (ascending):
 *      '128k', '320k', 'flac', 'flac24bit'
 *  (bitrate map: 128 -> 128k, 320 -> 320k, 2000 -> flac, 4000 -> flac24bit)
 * ============================================================================
 */

const zlib = require('zlib')

// ---------------------------------------------------------------------------
// GB18030 decoding helper.
//
//   lx's lyric decode (kw_decodeLyric.ts) finishes with
//   `iconv.decode(buf, 'gb18030')`. Node's WHATWG TextDecoder supports
//   'gb18030' on full-ICU builds (the default for official Node 18+). On a
//   small-ICU build it is unavailable; in that case we transparently fall back
//   to an optional `iconv-lite` if the host app happens to provide it. If
//   neither is available a clear, actionable error is thrown.
// ---------------------------------------------------------------------------
let _gbDecoder = null
const decodeGB18030 = buf => {
  if (_gbDecoder === null) {
    try {
      const td = new TextDecoder('gb18030')
      _gbDecoder = b => td.decode(b)
    } catch (_) {
      try {
        // optional, only if the host project installed it
        const iconv = require('iconv-lite')
        _gbDecoder = b => iconv.decode(b, 'gb18030')
      } catch (_2) {
        _gbDecoder = false
      }
    }
  }
  if (_gbDecoder === false) {
    throw new Error(
      "GB18030 decoding unavailable: this Node build lacks full ICU and 'iconv-lite' is not installed. " +
      "Run Node with full ICU (official Node 18+ has it) or `npm i iconv-lite`.",
    )
  }
  return _gbDecoder(buf)
}

// ---------------------------------------------------------------------------
// Inlined request helper — equivalent of lx's `httpFetch(url, options)`.
//
//   ORIGINAL CONTRACT (src/renderer/utils/request.js):
//     httpFetch(url, options = { method: 'get' }) -> { promise, cancelHttp, ... }
//     requestObj.promise resolves to a needle-shaped response:
//       { statusCode, headers, body, raw }
//     where:
//       - body is parsed JSON when format === 'json' (the default), else a string
//       - raw  is the raw response Buffer
//
//   Here httpFetch returns a Promise resolving to { statusCode, headers, body, raw }
//   with the same semantics, built on Node 18 global fetch.
// ---------------------------------------------------------------------------
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36',
}

const httpFetch = async(url, options = {}) => {
  const { method = 'get', headers = {}, format = 'json', timeout = 15000, body } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const resp = await fetch(url, {
      method: method.toUpperCase(),
      headers: Object.assign({}, DEFAULT_HEADERS, headers),
      body,
      signal: controller.signal,
      redirect: 'follow',
    })
    const raw = Buffer.from(await resp.arrayBuffer())
    const respHeaders = {}
    resp.headers.forEach((v, k) => { respHeaders[k] = v })
    // needle exposes set-cookie as an array; replicate for parity
    if (respHeaders['set-cookie']) respHeaders['set-cookie'] = [respHeaders['set-cookie']]

    let bodyOut = raw.toString()
    if (format === 'json') {
      try { bodyOut = JSON.parse(bodyOut) } catch (_) { /* leave as raw string */ }
    }
    return { statusCode: resp.status, headers: respHeaders, body: bodyOut, raw }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Helpers ported from lx-music
// ---------------------------------------------------------------------------
// Exact port of src/common/utils/common.ts numFix + formatPlayTime -> "mm:ss".
const numFix = n => (n < 10 ? `0${n}` : n.toString())
const formatPlayTime = time => {
  let m = Math.trunc(time / 60)
  let s = Math.trunc(time % 60)
  return m == 0 && s == 0 ? '--/--' : numFix(m) + ':' + numFix(s)
}

// decodeName — port of src/renderer/utils/index.ts, which used the browser
// DOMParser to decode HTML entities. We replicate full HTML-entity decoding
// (named + numeric decimal + numeric hex) without a DOM.
const htmlEntities = {
  quot: '"', amp: '&', apos: "'", lt: '<', gt: '>', nbsp: ' ',
  ensp: ' ', emsp: ' ', ndash: '–', mdash: '—', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', divide: '÷',
}
const decodeName = (str = '') => {
  if (!str) return ''
  return String(str)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in htmlEntities ? htmlEntities[name] : m))
}

// ---------------------------------------------------------------------------
// Helpers ported from src/renderer/utils/musicSdk/kw/util.js
// ---------------------------------------------------------------------------
const formatSinger = rawData => rawData.replace(/&/g, '、')

// Converts Kuwo's single-quoted pseudo-JSON into valid JSON, then parses it.
// Exact port of objStr2JSON in util.js.
const objStr2JSON = str => {
  return JSON.parse(str.replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'))
}

// lrcTools — word-by-word lyric parser (lxlyric). Faithful port from util.js
const lrcTools = {
  rxps: {
    wordLine: /^(\[\d{1,2}:.*\d{1,4}\])\s*(\S+(?:\s+\S+)*)?\s*/,
    tagLine: /\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]/,
    wordTimeAll: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g,
    wordTime: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/,
  },
  offset: 1,
  offset2: 1,
  isOK: false,
  lines: [],
  tags: [],
  getWordInfo(str, str2, prevWord) {
    const offset = parseInt(str)
    const offset2 = parseInt(str2)
    let startTime = Math.abs((offset + offset2) / (this.offset * 2))
    let endTime = Math.abs((offset - offset2) / (this.offset2 * 2)) + startTime
    if (prevWord) {
      if (startTime < prevWord.endTime) {
        prevWord.endTime = startTime
        if (prevWord.startTime > prevWord.endTime) {
          prevWord.startTime = prevWord.endTime
        }
        prevWord.newTimeStr = `<${prevWord.startTime},${prevWord.endTime - prevWord.startTime}>`
      }
    }
    return {
      startTime,
      endTime,
      timeStr: `<${startTime},${endTime - startTime}>`,
    }
  },
  parseLine(line) {
    if (line.length < 6) return
    let result = this.rxps.wordLine.exec(line)
    if (result) {
      const time = result[1]
      let words = result[2]
      if (words == null) {
        words = ''
      }
      const wordTimes = words.match(this.rxps.wordTimeAll)
      if (!wordTimes) return
      let preTimeInfo
      for (const timeStr of wordTimes) {
        const r = this.rxps.wordTime.exec(timeStr)
        const wordInfo = this.getWordInfo(r[1], r[2], preTimeInfo)
        words = words.replace(timeStr, wordInfo.timeStr)
        if (preTimeInfo && preTimeInfo.newTimeStr) words = words.replace(preTimeInfo.timeStr, preTimeInfo.newTimeStr)
        preTimeInfo = wordInfo
      }
      this.lines.push(time + words)
      return
    }
    result = this.rxps.tagLine.exec(line)
    if (!result) return
    if (result[1] == 'kuwo') {
      let content = result[2]
      if (content != null && content.includes('][')) {
        content = content.substring(0, content.indexOf(']['))
      }
      const valueOf = parseInt(content, 8)
      this.offset = Math.trunc(valueOf / 10)
      this.offset2 = Math.trunc(valueOf % 10)
      if (this.offset == 0 || Number.isNaN(this.offset) || this.offset2 == 0 || Number.isNaN(this.offset2)) {
        this.isOK = false
      }
    } else {
      this.tags.push(line)
    }
  },
  parse(lrc) {
    const lines = lrc.split(/\r\n|\r|\n/)
    const tools = Object.create(this)
    tools.isOK = true
    tools.offset = 1
    tools.offset2 = 1
    tools.lines = []
    tools.tags = []

    for (const line of lines) {
      if (!tools.isOK) throw new Error('failed')
      tools.parseLine(line)
    }
    if (!tools.lines.length) return ''
    let lrcs = tools.lines.join('\n')
    if (tools.tags.length) lrcs = `${tools.tags.join('\n')}\n${lrcs}`
    return lrcs
  },
}

// ---------------------------------------------------------------------------
// Lyric decode — exact port of src/main/modules/winMain/rendererEvent/kw_decodeLyric.ts
//
//   In lx this ran in the Electron MAIN process; the renderer reached it via
//   `decodeLyric({ lrcBase64, isGetLyricx })` (an IPC call) and lyric.js then
//   did `Buffer.from(base64Data, 'base64').toString()` on the result. The main
//   handler returns `Buffer.from(decodedString).toString('base64')`, so we do
//   the same here to keep getLyric()'s downstream parsing identical.
//
//   Algorithm (from kw_decodeLyric.ts):
//     1. If buf does NOT start with 'tp=content' -> return ''.
//     2. inflate( buf after the first '\r\n\r\n' ).
//     3. If !isGetLyricx -> iconv.decode(inflated, 'gb18030').
//     4. If isGetLyricx  -> base64-decode the inflated string, XOR each byte
//        with the 'yeelion' key, then iconv.decode(result, 'gb18030').
// ---------------------------------------------------------------------------
const buf_key = Buffer.from('yeelion')
const buf_key_len = buf_key.length

const inflate = data => new Promise((resolve, reject) => {
  zlib.inflate(data, (err, result) => (err ? reject(err) : resolve(result)))
})

const decodeLyricRaw = async(buf, isGetLyricx) => {
  if (buf.toString('utf8', 0, 10) != 'tp=content') return ''
  const lrcData = await inflate(buf.subarray(buf.indexOf('\r\n\r\n') + 4))

  if (!isGetLyricx) return decodeGB18030(lrcData)

  const buf_str = Buffer.from(lrcData.toString(), 'base64')
  const buf_str_len = buf_str.length
  const output = new Uint8Array(buf_str_len)
  let i = 0
  while (i < buf_str_len) {
    let j = 0
    while (j < buf_key_len && i < buf_str_len) {
      output[i] = buf_str[i] ^ buf_key[j]
      i++
      j++
    }
  }
  return decodeGB18030(Buffer.from(output))
}

// decodeLyric({ lrcBase64, isGetLyricx }) -> base64(decoded lyric string)
// (mirrors the IPC bridge so callers can Buffer.from(result,'base64').toString())
const decodeLyric = async({ lrcBase64, isGetLyricx }) => {
  const lrc = await decodeLyricRaw(Buffer.from(lrcBase64, 'base64'), isGetLyricx)
  return Buffer.from(lrc).toString('base64')
}

// ---------------------------------------------------------------------------
// SEARCH — ported from src/renderer/utils/musicSdk/kw/musicSearch.js
// ---------------------------------------------------------------------------
const musicSearch = {
  regExps: {
    mInfo: /level:(\w+),bitrate:(\d+),format:(\w+),size:([\w.]+)/,
  },
  limit: 30,
  total: 0,
  page: 0,
  allPage: 1,

  async _request(str, page, limit) {
    const { body } = await httpFetch(`http://search.kuwo.cn/r.s?client=kt&all=${encodeURIComponent(str)}&pn=${page - 1}&rn=${limit}&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1`, { format: 'buffer' })
    // The r.s endpoint does NOT return strict JSON: the payload is prefixed with
    // junk (e.g. "[object Object]\n"), uses single-quoted keys/values, and
    // URL-encodes the string field values. lx-music's needle layer normalises
    // this transparently; here we replicate it with objStr2JSON + URL-decode so
    // handleResult sees the same data lx's handleResult would.
    let text = Buffer.isBuffer(body) ? body.toString() : String(body)
    const brace = text.indexOf('{')
    if (brace > 0) text = text.slice(brace)
    let result
    try {
      result = JSON.parse(text)
    } catch (_) {
      result = objStr2JSON(text)
    }
    if (result && Array.isArray(result.abslist)) {
      for (const item of result.abslist) {
        for (const k of Object.keys(item)) {
          if (typeof item[k] === 'string' && item[k].includes('%')) {
            try { item[k] = decodeURIComponent(item[k]) } catch (_) { /* leave as-is */ }
          }
        }
      }
    }
    return { body: result }
  },

  handleResult(rawData) {
    const result = []
    if (!rawData) return result
    for (let i = 0; i < rawData.length; i++) {
      const info = rawData[i]
      let songId = info.MUSICRID.replace('MUSIC_', '')

      if (!info.N_MINFO) {
        return null
      }

      const types = []
      const _types = {}

      let infoArr = info.N_MINFO.split(';')
      for (let item of infoArr) {
        item = item.match(this.regExps.mInfo)
        if (item) {
          switch (item[2]) {
            case '4000':
              types.push({ type: 'flac24bit', size: item[4] })
              _types.flac24bit = { size: item[4].toLocaleUpperCase() }
              break
            case '2000':
              types.push({ type: 'flac', size: item[4] })
              _types.flac = { size: item[4].toLocaleUpperCase() }
              break
            case '320':
              types.push({ type: '320k', size: item[4] })
              _types['320k'] = { size: item[4].toLocaleUpperCase() }
              break
            case '128':
              types.push({ type: '128k', size: item[4] })
              _types['128k'] = { size: item[4].toLocaleUpperCase() }
              break
          }
        }
      }
      types.reverse()

      let interval = parseInt(info.DURATION)

      result.push({
        name: decodeName(info.SONGNAME),
        singer: formatSinger(decodeName(info.ARTIST)),
        source: 'kw',
        songmid: songId,
        albumId: decodeName(info.ALBUMID || ''),
        interval: Number.isNaN(interval) ? 0 : formatPlayTime(interval),
        albumName: info.ALBUM ? decodeName(info.ALBUM) : '',
        lrc: null,
        img: null,
        otherSource: null,
        types,
        _types,
        typeUrl: {},
      })
    }
    return result
  },

  async search(str, page = 1, limit, retryNum = 0) {
    if (retryNum > 2) throw new Error('try max num')
    if (limit == null) limit = this.limit

    const { body: result } = await this._request(str, page, limit)
    if (!result || (result.TOTAL !== '0' && result.SHOW === '0')) return this.search(str, page, limit, ++retryNum)
    let list = this.handleResult(result.abslist)
    if (list == null) return this.search(str, page, limit, ++retryNum)

    this.total = parseInt(result.TOTAL)
    this.page = page
    this.allPage = Math.ceil(this.total / limit)

    return {
      list,
      allPage: this.allPage,
      total: this.total,
      limit,
      page,
      source: 'kw',
    }
  },
}

// ---------------------------------------------------------------------------
// LYRIC — ported from src/renderer/utils/musicSdk/kw/lyric.js
// ---------------------------------------------------------------------------
const timeExp = /^\[([\d:.]*)\]{1}/g
const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/
const lyricxTag = /^<-?\d+,-?\d+>/

// Lyric REQUEST params: XOR-with-'yeelion' then base64 (this IS where the key
// is used — distinct from the response decode above). Port from lyric.js.
const buildLyricParams = (id, isGetLyricx) => {
  let params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${id}`
  if (isGetLyricx) params += '&lrcx=1'
  const buf_str = Buffer.from(params)
  const buf_str_len = buf_str.length
  const output = new Uint16Array(buf_str_len)
  let i = 0
  while (i < buf_str_len) {
    let j = 0
    while (j < buf_key_len && i < buf_str_len) {
      output[i] = buf_key[j] ^ buf_str[i]
      i++
      j++
    }
  }
  return Buffer.from(output).toString('base64')
}

const lyricApi = {
  sortLrcArr(arr) {
    const lrcSet = new Set()
    let lrc = []
    let lrcT = []

    let isLyricx = false
    for (const item of arr) {
      if (lrcSet.has(item.time)) {
        if (lrc.length < 2) continue
        const tItem = lrc.pop()
        tItem.time = lrc[lrc.length - 1].time
        lrcT.push(tItem)
        lrc.push(item)
      } else {
        lrc.push(item)
        lrcSet.add(item.time)
      }
      if (!isLyricx && lyricxTag.test(item.text)) isLyricx = true
    }

    if (!isLyricx && lrcT.length > lrc.length * 0.3 && lrc.length - lrcT.length > 6) {
      throw new Error('failed')
    }

    return { lrc, lrcT }
  },
  transformLrc(tags, lrclist) {
    return `${tags.join('\n')}\n${lrclist ? lrclist.map(l => `[${l.time}]${l.text}\n`).join('') : '暂无歌词'}`
  },
  parseLrc(lrc) {
    const lines = lrc.split(/\r\n|\r|\n/)
    let tags = []
    let lrcArr = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      let result = timeExp.exec(line)
      if (result) {
        const text = line.replace(timeExp, '').trim()
        let time = RegExp.$1
        if (/\.\d\d$/.test(time)) time += '0'
        lrcArr.push({ time, text })
      } else if (lrcTools.rxps.tagLine.test(line)) {
        tags.push(line)
      }
    }
    const lrcInfo = this.sortLrcArr(lrcArr)
    return {
      lyric: decodeName(this.transformLrc(tags, lrcInfo.lrc)),
      tlyric: lrcInfo.lrcT.length ? decodeName(this.transformLrc(tags, lrcInfo.lrcT)) : '',
    }
  },
  async getLyric(musicInfo, isGetLyricx = true) {
    const { statusCode, body, raw } = await httpFetch(
      `http://newlyric.kuwo.cn/newlyric.lrc?${buildLyricParams(musicInfo.songmid, isGetLyricx)}`,
      { format: 'buffer' },
    )
    if (statusCode != 200) throw new Error(JSON.stringify(body))

    const base64Data = await decodeLyric({ lrcBase64: raw.toString('base64'), isGetLyricx })

    let lrcInfo
    try {
      lrcInfo = this.parseLrc(Buffer.from(base64Data, 'base64').toString())
    } catch (err) {
      throw new Error('Get lyric failed')
    }
    if (lrcInfo.tlyric) lrcInfo.tlyric = lrcInfo.tlyric.replace(lrcTools.rxps.wordTimeAll, '')
    try {
      lrcInfo.lxlyric = lrcTools.parse(lrcInfo.lyric)
    } catch {
      lrcInfo.lxlyric = ''
    }
    lrcInfo.lyric = lrcInfo.lyric.replace(lrcTools.rxps.wordTimeAll, '')
    if (!existTimeExp.test(lrcInfo.lyric)) throw new Error('Get lyric failed')
    return lrcInfo
  },
}

// ---------------------------------------------------------------------------
// PIC — ported from src/renderer/utils/musicSdk/kw/pic.js
// ---------------------------------------------------------------------------
const picApi = {
  async getPic({ songmid }) {
    const { body } = await httpFetch(
      `http://artistpicserver.kuwo.cn/pic.web?corp=kuwo&type=rid_pic&pictype=500&size=500&rid=${songmid}`,
      { format: 'buffer' },
    )
    const str = Buffer.isBuffer(body) ? body.toString() : String(body)
    return /^http/.test(str) ? str : null
  },
}

// ---------------------------------------------------------------------------
// Public API (CommonJS)
// ---------------------------------------------------------------------------

/**
 * Search Kuwo for music.
 * @param {string} keyword
 * @param {number} [page=1]
 * @param {number} [limit=30]
 * @returns {Promise<{list: object[], total: number, page: number, limit: number, allPage: number, source: 'kw'}>}
 */
async function search(keyword, page = 1, limit = 30) {
  return musicSearch.search(keyword, page, limit)
}

/**
 * Get lyric for a kw musicInfo (must contain `songmid`).
 * @param {object} musicInfo
 * @returns {Promise<{lyric: string, tlyric: string, lxlyric: string}>}
 */
async function getLyric(musicInfo, isGetLyricx = true) {
  return lyricApi.getLyric(musicInfo, isGetLyricx)
}

/**
 * Get album-art URL for a kw musicInfo (must contain `songmid`).
 * @param {object} musicInfo
 * @returns {Promise<string|null>}
 */
async function getPic(musicInfo) {
  return picApi.getPic(musicInfo)
}

module.exports = {
  search,
  getLyric,
  getPic,
  // exported for testing / reuse
  httpFetch,
  decodeName,
  formatPlayTime,
  formatSinger,
}
