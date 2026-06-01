'use strict'
// Node port of the lx-music "user API" sandbox.
// Original (Electron) ran the source script inside a hidden BrowserWindow with a
// preload that exposed `globalThis.lx` (see lx-music-desktop-master/src/main/
// modules/userApi/renderer/preload.js). Here we run the same script text inside a
// Node `vm` context and expose an equivalent `lx` object, so the third-party
// `latest.js` music-source scripts run unmodified on a server.
//
// A source script registers `lx.on('request', handler)` and (after init) calls
// `lx.send('inited', {...})`. To get a play URL we invoke the handler with
//   { source: 'kw', action: 'musicUrl', info: { type: '128k', musicInfo } }
// and the handler resolves to an http(s) URL string.

const vm = require('node:vm')
const { createCipheriv, publicEncrypt, constants, randomBytes, createHash } = require('node:crypto')
const zlib = require('node:zlib')
const { request } = require('./request')

const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' }

// Source scripts kick off async network calls during init (e.g. ikun hits
// api.ikunshare.com). If one rejects with no .catch it becomes an unhandled
// rejection that would crash the whole Node process. The original Electron
// preload guarded this with window error/unhandledrejection listeners; here we
// install a process-level guard so a misbehaving source can't take down the
// server. Real backend errors are handled via try/catch in the API layer.
if (!global.__lx_sandbox_guard__) {
  global.__lx_sandbox_guard__ = true
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason)
    console.error('[sandbox] ignored unhandledRejection from a source script:', msg)
  })
}

const buildUtils = () => ({
  crypto: {
    aesEncrypt(buffer, mode, key, iv) {
      const cipher = createCipheriv(mode, key, iv)
      return Buffer.concat([cipher.update(buffer), cipher.final()])
    },
    rsaEncrypt(buffer, key) {
      buffer = Buffer.concat([Buffer.alloc(128 - buffer.length), buffer])
      return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, buffer)
    },
    randomBytes(size) { return randomBytes(size) },
    md5(str) { return createHash('md5').update(str).digest('hex') },
  },
  buffer: {
    from(...args) { return Buffer.from(...args) },
    bufToString(buf, format) { return Buffer.from(buf, 'binary').toString(format) },
  },
  zlib: {
    inflate(buf) {
      return new Promise((resolve, reject) => {
        zlib.inflate(buf, (err, data) => err ? reject(new Error(err.message)) : resolve(data))
      })
    },
    deflate(data) {
      return new Promise((resolve, reject) => {
        zlib.deflate(data, (err, buf) => err ? reject(new Error(err.message)) : resolve(buf))
      })
    },
  },
})

class MusicSource {
  constructor({ id, name, script, info = {} }) {
    this.id = id
    this.name = name || info.name || id
    this.script = script
    this.info = info
    this.inited = false
    this.sourceInfo = null      // { sources: { kw: { actions, qualitys }, ... } }
    this.requestHandler = null
    this.error = null
  }

  _makeLx() {
    const self = this
    return {
      EVENT_NAMES,
      request(url, options, callback) {
        if (typeof options === 'function') { callback = options; options = {} }
        return request(url, options || {}, function (err, resp, body) {
          try { callback && callback.call(this, err, resp, body) } catch (e) { /* swallow */ }
        })
      },
      send(eventName, data) {
        return new Promise((resolve, reject) => {
          switch (eventName) {
            case EVENT_NAMES.inited:
              self.inited = true
              self.sourceInfo = data
              resolve()
              break
            case EVENT_NAMES.updateAlert:
              resolve()
              break
            default:
              reject(new Error('Unknown event name: ' + eventName))
          }
        })
      },
      on(eventName, handler) {
        if (eventName === EVENT_NAMES.request) { self.requestHandler = handler; return Promise.resolve() }
        return Promise.reject(new Error('The event is not supported: ' + eventName))
      },
      utils: buildUtils(),
      currentScriptInfo: {
        name: self.name,
        description: self.info.description || '',
        version: self.info.version || '',
        author: self.info.author || '',
        homepage: self.info.homepage || '',
        rawScript: self.script,
      },
      version: '2.0.0',
      env: 'desktop',
    }
  }

  load() {
    const lx = this._makeLx()
    const sandbox = {
      lx,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    }
    sandbox.globalThis = sandbox
    const context = vm.createContext(sandbox)
    try {
      vm.runInContext(this.script, context, { timeout: 10000, filename: `${this.id}.js` })
    } catch (e) {
      this.error = e
      throw e
    }
    return this
  }

  isReady() { return typeof this.requestHandler === 'function' }

  // quality: e.g. '128k' | '320k' | 'flac'
  async getMusicUrl(source, musicInfo, quality = '128k') {
    if (!this.isReady()) throw new Error(`source "${this.id}" not ready (no request handler)`)
    const info = { type: quality, musicInfo }
    const result = await this.requestHandler.call(null, { source, action: 'musicUrl', info })
    if (typeof result !== 'string' || result.length > 4096 || !/^https?:/.test(result)) {
      throw new Error('source returned invalid url')
    }
    return result
  }
}

module.exports = { MusicSource, EVENT_NAMES }
