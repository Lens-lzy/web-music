'use strict'
const sources = require('../server/lib/sources')
const kg = require('../server/musicSdk/kg')
const http = require('http'); const https = require('https'); const { URL } = require('url')
const fs = require('fs')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

const head = (u, n = 5) => new Promise(r => {
  let o; try { o = new URL(u) } catch (e) { return r('badurl') }
  const lib = o.protocol === 'https:' ? https : http
  const q = lib.request(o, { method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-512' } }, res => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) { res.resume(); return r(n > 0 ? head(new URL(res.headers.location, o).toString(), n - 1) : 'maxredir') }
    const ct = res.headers['content-type'] || ''; const ch = []
    res.on('data', c => { ch.push(c); if (Buffer.concat(ch).length >= 512) q.destroy() })
    const fin = () => { const b = Buffer.concat(ch); const id3 = b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33; const fr = b[0] === 0xff && (b[1] & 0xe0) === 0xe0; r(`${res.statusCode} ct=${ct.slice(0, 20)} audio=${id3 || fr}`) }
    res.on('end', fin); res.on('close', fin)
  })
  q.on('error', e => r('ERR ' + e.message)); q.setTimeout(8000, () => { q.destroy(); r('timeout') }); q.end()
})

const arg = process.argv[2] || '周杰伦'
;(async () => {
  const out = []
  try {
    sources.loadAll()
    const r = await kg.search(arg, 1, 5); const m = r.list[0]
    out.push('SONG=' + m.name + '/' + m.singer + ' hash=' + m.hash + ' mid=' + m.songmid)
    for (const sid of ['juhe', 'lx', 'grass', 'flower', 'huibq', 'sixyin']) {
      const s = sources.get(sid); if (!s || !s.isReady()) { out.push(sid + '=notready'); continue }
      let u; try { u = await s.getMusicUrl('kg', m, '128k') } catch (e) { out.push(sid + '=ERR ' + e.message.slice(0, 40)); continue }
      const h = await head(u); out.push(sid + ': ' + h + ' :: ' + u.slice(0, 55))
    }
  } catch (e) { out.push('FATAL ' + e.message) }
  fs.writeFileSync('/tmp/diag.txt', out.join('\n') + '\n')
  setTimeout(() => process.exit(0), 800)
})()
