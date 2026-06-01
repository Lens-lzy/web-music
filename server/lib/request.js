'use strict'
// A small Node http/https client that mimics the subset of `needle`'s behaviour
// that lx-music source scripts rely on (see the original Electron preload at
// src/main/modules/userApi/renderer/preload.js -> lx.request).
//
// Signature mirrors the sandbox `lx.request`:
//   request(url, { method, timeout, headers, body, form, formData }, callback)
// callback(err, response, body) where
//   response = { statusCode, statusMessage, headers, bytes, raw, body }
//   body is JSON-parsed when possible, otherwise the raw string.
// Returns a cancel function.

const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')
const zlib = require('node:zlib')

const MAX_REDIRECTS = 5

const encodeForm = (obj) => {
  if (typeof obj === 'string') return obj
  return Object.keys(obj)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(obj[k] == null ? '' : obj[k])}`)
    .join('&')
}

const buildBody = (options) => {
  // Returns { data: Buffer|string|null, contentType: string|null }
  if (options.body != null) {
    if (Buffer.isBuffer(options.body) || typeof options.body === 'string') {
      return { data: options.body, contentType: null }
    }
    return { data: JSON.stringify(options.body), contentType: 'application/json' }
  }
  if (options.form != null) {
    return { data: encodeForm(options.form), contentType: 'application/x-www-form-urlencoded' }
  }
  if (options.formData != null) {
    // Minimal: treat as urlencoded. (Multipart is rarely needed by these sources.)
    return { data: encodeForm(options.formData), contentType: 'application/x-www-form-urlencoded' }
  }
  return { data: null, contentType: null }
}

const doRequest = (urlStr, options, callback, redirectsLeft, cancelRef) => {
  let urlObj
  try {
    urlObj = new URL(urlStr)
  } catch (e) {
    return callback(new Error('Invalid URL: ' + urlStr), null, null)
  }
  const isHttps = urlObj.protocol === 'https:'
  const lib = isHttps ? https : http

  const method = (options.method || 'GET').toUpperCase()
  const { data, contentType } = buildBody(options)

  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) lx-web-music',
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
  }, options.headers || {})
  if (contentType && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = contentType
  }
  if (data != null) {
    headers['Content-Length'] = Buffer.byteLength(data)
  }

  const reqOptions = {
    method,
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    headers,
    agent: options.agent,
    timeout: typeof options.timeout === 'number' && options.timeout > 0 ? Math.min(options.timeout, 60000) : 25000,
  }

  const req = lib.request(reqOptions, (res) => {
    // Redirect handling (opt-in via follow, default follows for safety up to MAX)
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
      res.resume() // drain
      const next = new URL(res.headers.location, urlObj).toString()
      const nextOptions = Object.assign({}, options)
      if (res.statusCode === 303) { nextOptions.method = 'GET'; delete nextOptions.body; delete nextOptions.form; delete nextOptions.formData }
      return doRequest(next, nextOptions, callback, redirectsLeft - 1, cancelRef)
    }

    const chunks = []
    res.on('data', c => chunks.push(c))
    res.on('end', () => {
      let buf = Buffer.concat(chunks)
      const enc = (res.headers['content-encoding'] || '').toLowerCase()
      try {
        if (enc === 'gzip') buf = zlib.gunzipSync(buf)
        else if (enc === 'deflate') buf = zlib.inflateSync(buf)
        else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
      } catch (_) { /* keep raw */ }

      let bodyStr = buf.toString('utf8')
      let body = bodyStr
      try { body = JSON.parse(bodyStr) } catch (_) {}

      callback(null, {
        statusCode: res.statusCode,
        statusMessage: res.statusMessage,
        headers: res.headers,
        bytes: buf.length,
        raw: buf,
        body,
      }, body)
    })
  })

  cancelRef.fn = () => { try { req.destroy() } catch (_) {} }

  req.on('error', (err) => callback(err, null, null))
  req.on('timeout', () => { req.destroy(new Error('Request timeout')) })

  if (data != null) req.write(data)
  req.end()
}

const request = (url, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {} }
  options = options || {}
  const cancelRef = { fn: () => {} }
  doRequest(url, options, callback, MAX_REDIRECTS, cancelRef)
  return () => cancelRef.fn()
}

// Promise helper used elsewhere in the backend.
const requestAsync = (url, options = {}) => new Promise((resolve, reject) => {
  request(url, options, (err, resp) => {
    if (err) reject(err)
    else resolve(resp)
  })
})

module.exports = { request, requestAsync }
