'use strict'
// Loads the third-party music-source scripts (latest.js) from the
// lx-music-source repo folder and wraps each in a Node sandbox (MusicSource).
// Each source is isolated: one failing script does not break the others.

const fs = require('node:fs')
const path = require('node:path')
const { MusicSource } = require('./sandbox')

// Where the `*/latest.js` source scripts live. Override with LX_SOURCE_DIR.
// Bundled copy lives at <package-root>/lx-music-source-main (server/lib -> ../..).
const DEFAULT_SOURCE_DIR = path.resolve(__dirname, '..', '..', 'lx-music-source-main')
const SOURCE_DIR = process.env.LX_SOURCE_DIR || DEFAULT_SOURCE_DIR

// 随仓库提交的内置源（server/sources-bundled/<id>/latest.js）。git pull 即部署，
// 不依赖 LX_SOURCE_DIR / fetch-sources。聚合音源等可读、可维护的源放这里。
const BUNDLED_SOURCE_DIR = path.resolve(__dirname, '..', 'sources-bundled')

const INFO_KEYS = ['name', 'description', 'version', 'author', 'homepage']

const parseHeader = (script) => {
  const info = {}
  const head = script.slice(0, 2000)
  for (const key of INFO_KEYS) {
    const m = new RegExp(`@${key}\\s+(.+)`).exec(head)
    if (m) info[key] = m[1].trim()
  }
  return info
}

// registry: Map<sourceId, MusicSource>
const registry = new Map()

// Preferred order for auto source selection (lower = tried first). Sources known
// to return clean CDN audio go first; ones that often hit ISP P2P-blocking or
// dead links go last. Override with LX_SOURCE_PRIORITY="juhe,lx,huibq".
const DEFAULT_PRIORITY = (process.env.LX_SOURCE_PRIORITY || 'qdyaggr,juhe,lx,grass,flower,huibq,sixyin,ikun').split(',').map(s => s.trim())
const priorityOf = (id) => {
  const i = DEFAULT_PRIORITY.indexOf(id)
  return i === -1 ? 999 : i
}

// 从一个目录加载所有 <id>/latest.js 源；同名 id 后加载的覆盖先加载的。
const loadFromDir = (dir) => {
  let dirents
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return  // 目录不存在/不可读则跳过（内置目录或外部目录任一缺失都不致命）
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const id = d.name
    const file = path.join(dir, id, 'latest.js')
    if (!fs.existsSync(file)) continue
    let script
    try {
      script = fs.readFileSync(file, 'utf8')
    } catch (e) {
      console.error(`[sources] read fail ${id}: ${e.message}`)
      continue
    }
    const info = parseHeader(script)
    const src = new MusicSource({ id, name: info.name || id, script, info })
    try {
      src.load()
      registry.set(id, src)
      console.log(`[sources] loaded "${id}" (${info.name || id} ${info.version || ''}) ready=${src.isReady()}`)
    } catch (e) {
      console.error(`[sources] load fail "${id}": ${e.message}`)
    }
  }
}

const loadAll = () => {
  registry.clear()
  loadFromDir(BUNDLED_SOURCE_DIR)   // 内置源（随仓库）
  loadFromDir(SOURCE_DIR)           // 外部源（LX_SOURCE_DIR，可覆盖同名）
  if (registry.size === 0) console.warn('[sources] no source scripts loaded')
  return registry
}

const list = () => Array.from(registry.values())
  .map(s => ({
    id: s.id,
    name: s.name,
    version: s.info.version || '',
    author: s.info.author || '',
    ready: s.isReady(),
    priority: priorityOf(s.id),
  }))
  .sort((a, b) => a.priority - b.priority)

const get = (id) => registry.get(id)

module.exports = { loadAll, list, get, registry, SOURCE_DIR, priorityOf }
