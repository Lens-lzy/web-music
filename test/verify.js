'use strict'
const sources = require('../server/lib/sources')
const kw = require('../server/musicSdk/kw')
const fs = require('fs')
;(async () => {
  const out = []
  try {
    sources.loadAll()
    out.push('SOURCES=' + sources.list().map(x => x.id + ':' + (x.ready ? 'Y' : 'N')).join(','))
    const r = await kw.search('周杰伦', 1, 5)
    const m = r.list && r.list[0]
    out.push('SEARCH_N=' + (r.list ? r.list.length : 'null'))
    if (m) {
      out.push('MID=' + m.songmid)
      out.push('NAME=' + m.name + '/' + m.singer)
      for (const s of sources.list().filter(x => x.ready)) {
        try {
          const url = await sources.get(s.id).getMusicUrl('kw', m, '128k')
          out.push('OK_' + s.id + '=' + String(url).slice(0, 45))
        } catch (e) { out.push('NO_' + s.id + '=' + String(e.message).slice(0, 35)) }
      }
      try { const ly = await kw.getLyric(m); out.push('LYRIC_LEN=' + ((ly && (ly.lyric || ly)) || '').length) } catch (e) { out.push('LYRIC_ERR=' + e.message) }
      try { const p = await kw.getPic(m); out.push('PIC=' + (p ? String(p).slice(0, 35) : 'none')) } catch (e) { out.push('PIC_ERR=' + e.message) }
    }
  } catch (e) { out.push('FATAL=' + e.message) }
  fs.writeFileSync('/tmp/verify.txt', out.join('\n') + '\n')
  // wait a moment to let any source async-init rejections fire (guard should catch them)
  setTimeout(() => process.exit(0), 2500)
})()
