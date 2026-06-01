'use strict'
const sources = require('../server/lib/sources')
const kg = require('../server/musicSdk/kg')
const fs = require('fs')
;(async () => {
  const out = []
  try {
    sources.loadAll()
    out.push('SOURCES=' + sources.list().map(x => x.id + ':' + (x.ready ? 'Y' : 'N')).join(','))
    const r = await kg.search('周杰伦 晴天', 1, 5)
    out.push('SEARCH_N=' + r.list.length)
    const m = r.list[0]
    if (m) {
      out.push('M=' + JSON.stringify({ name: m.name, singer: m.singer, songmid: m.songmid, hash: m.hash, source: m.source, qualities: m.types.map(t => t.type) }))
      for (const s of sources.list().filter(x => x.ready)) {
        try {
          const url = await sources.get(s.id).getMusicUrl('kg', m, '128k')
          out.push('OK_' + s.id + '=' + String(url).slice(0, 55))
        } catch (e) { out.push('NO_' + s.id + '=' + String(e.message).slice(0, 40)) }
      }
      try { const ly = await kg.getLyric(m); out.push('LYRIC_LEN=' + ((ly.lyric || '').length)) } catch (e) { out.push('LYRIC_ERR=' + e.message) }
      try { const p = await kg.getPic(m); out.push('PIC=' + (p ? String(p).slice(0, 40) : 'none')) } catch (e) { out.push('PIC_ERR=' + e.message) }
    }
  } catch (e) { out.push('FATAL=' + e.message) }
  fs.writeFileSync('/tmp/verify2.txt', out.join('\n') + '\n')
  setTimeout(() => process.exit(0), 2000)
})()
