import express from "express"
import fetch from "node-fetch"
import http from "node:http"
import https from "node:https"
import dns from "node:dns"
import net from "node:net"
import zlib from "node:zlib"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { pipeline } from "node:stream"
import { fileURLToPath } from "node:url"
import { WebSocket, WebSocketServer } from "ws"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// =========================
// 設定 (環境変数で変更可能)
// =========================
const PORT = process.env.PORT || 3000
const PREFIX = "/proxy/"
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT_MS) || 30000
// 1 にするとローカル/社内ネットワークへのアクセスを許可 (通常は無効のままにしてください)
const ALLOW_PRIVATE_NETWORK = process.env.ALLOW_PRIVATE_NETWORK === "1"
// これより大きい HTML/CSS は書き換えずにそのまま流す
const MAX_REWRITE_BYTES = 25 * 1024 * 1024
// 直前に表示していたサイトを覚えておく cookie (取りこぼしたリクエストの救済用)
const ORIGIN_COOKIE = "science_origin"

const CLIENT_SCRIPT = fs.readFileSync(path.join(__dirname, "inject.js"), "utf8")
const INJECT_TAG = `<script data-science>${CLIENT_SCRIPT.replace(/<\/(script)/gi, "<\\/$1")}</script>`

const SKIP_SCHEME = /^(data|blob|javascript|about|mailto|tel|sms|intent|file|vbscript):/i
const PROXYABLE_PROTOCOL = /^(https?|wss?):$/

// =========================
// プライベートネットワーク保護 (SSRF 対策)
// =========================
const blockList = new net.BlockList()
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockList.addSubnet(addr, prefix, "ipv4")
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockList.addSubnet(addr, prefix, "ipv6")

function isBlockedAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) address = mapped[1]
  const family = net.isIP(address)
  if (!family) return true
  return blockList.check(address, family === 4 ? "ipv4" : "ipv6")
}

// DNS 解決の結果をチェックするので、DNS rebinding でも内部に到達できない
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options
    options = {}
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err)
    if (!ALLOW_PRIVATE_NETWORK) {
      const list = Array.isArray(address) ? address : [{ address }]
      if (list.some(a => isBlockedAddress(a.address))) {
        const e = new Error(`Blocked private network address for ${hostname}`)
        e.code = "EPRIVATE"
        return callback(e)
      }
    }
    callback(null, address, family)
  })
}

// IP アドレスが直接指定された場合は DNS を通らないので、ここで個別にチェック
function assertPublicHost(url) {
  if (ALLOW_PRIVATE_NETWORK) return
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (net.isIP(host) && isBlockedAddress(host)) {
    const e = new Error(`Blocked private network address ${host}`)
    e.code = "EPRIVATE"
    throw e
  }
}

// keep-alive で接続を再利用して高速化
const agentOptions = { keepAlive: true, maxSockets: 256, lookup: guardedLookup }
const httpAgent = new http.Agent(agentOptions)
const httpsAgent = new https.Agent(agentOptions)
const pickAgent = u => (u.protocol === "http:" ? httpAgent : httpsAgent)

// =========================
// URL ユーティリティ
// =========================
// プロキシ URL の形式: /proxy/https://example.com/path?query
// (エンコードしない形式なので、ページ内の相対 URL がブラウザで正しく解決される)
function parseTarget(raw) {
  let s = raw
  let canonical = true
  // 旧形式 /proxy/https%3A%2F%2F... にも対応
  if (/^(https?|wss?)%3A/i.test(s)) {
    try {
      s = decodeURIComponent(s)
    } catch {
      return null
    }
    canonical = false
  }
  // ホスティング側で // が / にまとめられた場合の修復
  const fixed = s.replace(/^(https?|wss?):\/*/i, (m, p) => `${p.toLowerCase()}://`)
  if (fixed !== s) canonical = false
  if (!/^(https?|wss?):\/\/[^/?#]+\//i.test(fixed)) canonical = false
  let url
  try {
    url = new URL(fixed)
  } catch {
    return null
  }
  if (!PROXYABLE_PROTOCOL.test(url.protocol) || !url.hostname) return null
  return { url, canonical }
}

// "http://proxy/proxy/https://site/page" -> URL("https://site/page")
function fromProxyUrl(value) {
  if (!value) return null
  try {
    const u = new URL(value)
    if (!u.pathname.startsWith(PREFIX)) return null
    return parseTarget((u.pathname + u.search).slice(PREFIX.length))?.url ?? null
  } catch {
    return null
  }
}

function proxifyAbsolute(value, base) {
  try {
    const u = new URL(value, base)
    if (PROXYABLE_PROTOCOL.test(u.protocol)) return PREFIX + u.href
  } catch {}
  return value
}

const siteOf = host => host.split(".").slice(-2).join(".")

// =========================
// Cookie (サイトごとにパスで分離)
// =========================
// Set-Cookie の Path を /proxy/<origin>/ に付け替えて、サイト間で cookie が混ざらないようにする。
// __Host- / __Secure- は Path=/ などの制約があるので名前を置き換えて保存し、送信時に戻す。
const COOKIE_NAME_MAP = [["__Host-", "__sci_host__"], ["__Secure-", "__sci_secure__"]]
const encodeCookieName = n => {
  for (const [a, b] of COOKIE_NAME_MAP) if (n.startsWith(a)) return b + n.slice(a.length)
  return n
}
const decodeCookieName = n => {
  for (const [a, b] of COOKIE_NAME_MAP) if (n.startsWith(b)) return a + n.slice(b.length)
  return n
}

function rewriteSetCookie(header, target, secure) {
  const [pair, ...attrs] = header.split(";")
  const eq = pair.indexOf("=")
  const name = eq < 0 ? "" : pair.slice(0, eq).trim()
  const value = eq < 0 ? pair.trim() : pair.slice(eq + 1).trim()
  let cookiePath = "/"
  const out = []
  for (const attr of attrs) {
    const i = attr.indexOf("=")
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase()
    const val = i < 0 ? "" : attr.slice(i + 1).trim()
    if (!key || key === "domain") continue
    if (key === "path") {
      if (val.startsWith("/")) cookiePath = val
      continue
    }
    if (key === "secure" || key === "partitioned") {
      if (secure) out.push(key === "secure" ? "Secure" : "Partitioned")
      continue
    }
    if (key === "samesite") {
      out.push(!secure && val.toLowerCase() === "none" ? "SameSite=Lax" : `SameSite=${val}`)
      continue
    }
    out.push(attr.trim())
  }
  const fullName = name ? `${encodeCookieName(name)}=` : ""
  return [`${fullName}${value}`, `Path=${PREFIX}${target.origin}${cookiePath}`, ...out].join("; ")
}

function upstreamCookieHeader(header) {
  if (!header) return ""
  return header
    .split(/;\s*/)
    .filter(p => p && !p.startsWith(`${ORIGIN_COOKIE}=`))
    .map(p => {
      const i = p.indexOf("=")
      return i < 0 ? p : decodeCookieName(p.slice(0, i)) + p.slice(i)
    })
    .join("; ")
}

function readCookie(header, name) {
  for (const p of (header || "").split(/;\s*/)) {
    if (p.startsWith(`${name}=`)) return p.slice(name.length + 1)
  }
  return null
}

// =========================
// リクエストヘッダー
// =========================
const DROP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization",
  "transfer-encoding", "te", "trailer", "upgrade", "accept-encoding", "cookie", "origin",
  "referer", "forwarded", "via", "x-real-ip", "true-client-ip", "service-worker",
  "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions",
  "sec-websocket-protocol",
])

function buildUpstreamHeaders(req, target) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    // 利用者の IP などをサイトに漏らさない
    if (DROP_REQUEST_HEADERS.has(key) || key.startsWith("x-forwarded-") || key.startsWith("cf-")) continue
    headers[key] = value
  }
  headers["accept-encoding"] = "gzip, deflate, br"

  const cookie = upstreamCookieHeader(req.headers.cookie)
  if (cookie) headers.cookie = cookie

  // Referer / Origin は「プロキシの URL」ではなく「本来のサイトの URL」に直す
  const page = fromProxyUrl(req.headers.referer)
  if (page) headers.referer = page.href
  if (req.headers.origin) headers.origin = (page || target).origin
  if (req.headers["sec-fetch-site"]) {
    headers["sec-fetch-site"] = !page
      ? "none"
      : page.origin === target.origin
        ? "same-origin"
        : siteOf(page.hostname) === siteOf(target.hostname)
          ? "same-site"
          : "cross-site"
  }
  return headers
}

// =========================
// レスポンスヘッダー
// =========================
const DROP_RESPONSE_HEADERS = new Set([
  "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "strict-transport-security", "public-key-pins", "expect-ct", "clear-site-data",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "origin-agent-cluster", "report-to", "reporting-endpoints", "nel", "alt-svc",
  "service-worker-allowed", "link", "referrer-policy",
  "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive",
])

function rewriteRefresh(value, base) {
  const m = /^(\s*\d+(?:\.\d+)?\s*[;,]?\s*(?:url\s*=\s*)?)(['"]?)(.+?)\2\s*$/i.exec(value)
  if (!m || !/[;,]|url/i.test(m[1])) return value
  return m[1] + m[2] + proxifyAbsolute(m[3], base) + m[2]
}

function copyResponseHeaders(upstream, res, target, secure) {
  for (const [key, values] of Object.entries(upstream.headers.raw())) {
    if (DROP_RESPONSE_HEADERS.has(key)) continue
    if (key === "set-cookie") {
      res.setHeader("set-cookie", values.map(v => rewriteSetCookie(v, target, secure)))
    } else if (key === "location") {
      res.setHeader("location", proxifyAbsolute(values[0], target))
    } else if (key === "refresh") {
      res.setHeader("refresh", rewriteRefresh(values[0], target))
    } else {
      res.setHeader(key, values.length === 1 ? values[0] : values)
    }
  }
}

// =========================
// 文字コード / 圧縮
// =========================
const gunzip = promisify(zlib.gunzip)
const inflate = promisify(zlib.inflate)
const inflateRaw = promisify(zlib.inflateRaw)
const brotliDecompress = promisify(zlib.brotliDecompress)
const gzip = promisify(zlib.gzip)
const brotliCompress = promisify(zlib.brotliCompress)

async function decompress(buf, encoding) {
  const enc = (encoding || "").trim().toLowerCase()
  if (!enc || enc === "identity") return buf
  if (enc === "gzip" || enc === "x-gzip") return gunzip(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH })
  if (enc === "br") return brotliDecompress(buf)
  if (enc === "deflate") return inflate(buf).catch(() => inflateRaw(buf))
  throw new Error(`Unsupported content-encoding: ${enc}`)
}

// Shift_JIS / EUC-JP などのサイトも文字化けしないように判定して UTF-8 に変換する
function detectCharset(contentType, buf, kind) {
  let m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)
  if (m) return m[1]
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return "utf-8"
  if (buf[0] === 0xff && buf[1] === 0xfe) return "utf-16le"
  if (buf[0] === 0xfe && buf[1] === 0xff) return "utf-16be"
  const head = buf.subarray(0, 4096).toString("latin1")
  m = kind === "html"
    ? /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)
    : /^@charset\s+["']([\w.:-]+)["']/i.exec(head)
  return m ? m[1] : "utf-8"
}

function decodeText(buf, charset) {
  try {
    return new TextDecoder(charset).decode(buf)
  } catch {
    return new TextDecoder("utf-8").decode(buf)
  }
}

async function sendText(req, res, text) {
  let body = Buffer.from(text, "utf8")
  const accept = String(req.headers["accept-encoding"] || "")
  res.append("vary", "Accept-Encoding")
  if (body.length > 1024) {
    if (/\bbr\b/.test(accept)) {
      body = await brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
      res.setHeader("content-encoding", "br")
    } else if (/\bgzip\b/.test(accept)) {
      body = await gzip(body)
      res.setHeader("content-encoding", "gzip")
    }
  }
  res.setHeader("content-length", body.length)
  res.end(req.method === "HEAD" ? undefined : body)
}

// =========================
// HTML / CSS 書き換え
// =========================
const URL_ATTRS = new Set([
  "src", "href", "action", "formaction", "poster", "background", "cite", "longdesc",
  "manifest", "xlink:href", "lowsrc", "icon",
])
const TOKEN_RE =
  /<!--[\s\S]*?-->|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi
const ATTR_RE = /([^\s"'<>/=]+)(\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const BASE_RE = /<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
function decodeEntities(s) {
  if (s.indexOf("&") < 0) return s
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));?/gi, (m, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()]
    const cp = dec ? Number(dec) : parseInt(hex, 16)
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
  })
}
const escapeAttr = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;")

function getAttr(attrs, wanted) {
  ATTR_RE.lastIndex = 0
  let m
  while ((m = ATTR_RE.exec(attrs))) {
    if (m[1].toLowerCase() === wanted) return decodeEntities(m[3] ?? m[4] ?? m[5] ?? "")
  }
  return null
}

function createRewriter(pageUrl) {
  let base = pageUrl

  const url = value => {
    const v = value.trim()
    if (!v || v[0] === "#" || SKIP_SCHEME.test(v) || v.startsWith(PREFIX)) return value
    try {
      const abs = new URL(v, base)
      return PROXYABLE_PROTOCOL.test(abs.protocol) ? PREFIX + abs.href : value
    } catch {
      return value
    }
  }

  const srcset = value => {
    if (value.includes("data:")) return value
    return value
      .split(",")
      .map(part => {
        const m = /^(\s*)(\S+)([\s\S]*)$/.exec(part)
        return m ? m[1] + url(m[2]) + m[3] : part
      })
      .join(",")
  }

  const css = text =>
    text
      .replace(CSS_URL_RE, (m, dq, sq, uq) => {
        const v = dq ?? sq ?? uq
        if (!v) return m
        const q = dq != null ? '"' : sq != null ? "'" : ""
        return `url(${q}${url(v)}${q})`
      })
      .replace(CSS_IMPORT_RE, (m, dq, sq) => {
        const q = dq != null ? '"' : "'"
        return `@import ${q}${url(dq ?? sq)}${q}`
      })

  const importMap = body => {
    try {
      const map = JSON.parse(body)
      const fix = obj => {
        if (!obj) return obj
        const out = {}
        for (const [k, v] of Object.entries(obj)) out[k] = typeof v === "string" ? url(v) : v
        return out
      }
      map.imports = fix(map.imports)
      if (map.scopes) {
        const scopes = {}
        for (const [k, v] of Object.entries(map.scopes)) scopes[url(k)] = fix(v)
        map.scopes = scopes
      }
      return JSON.stringify(map)
    } catch {
      return body
    }
  }

  // タグの属性を書き換える。null を返すとタグごと削除
  const tag = (tagName, attrs) => {
    const name = tagName.toLowerCase()
    let refresh = false
    if (name === "meta") {
      const equiv = (getAttr(attrs, "http-equiv") || "").toLowerCase()
      if (equiv.startsWith("content-security-policy") || equiv === "x-frame-options") return null
      if ((getAttr(attrs, "name") || "").toLowerCase() === "referrer") return null
      refresh = equiv === "refresh"
    }
    return attrs.replace(ATTR_RE, (m, attr, eqPart, dq, sq, uq) => {
      if (eqPart === undefined) return m
      const lower = attr.toLowerCase()
      if (lower === "integrity") return ""
      const value = decodeEntities(dq ?? sq ?? uq)
      let out
      if (URL_ATTRS.has(lower) || (lower === "data" && name === "object")) out = url(value)
      else if (lower === "srcset" || lower === "imagesrcset") out = srcset(value)
      else if (lower === "style") out = css(value)
      else if (lower === "srcdoc") out = html(value, false)
      else if (lower === "ping") out = value.split(/\s+/).map(url).join(" ")
      else if (lower === "content" && refresh) out = rewriteRefresh(value, base)
      else return m
      return `${attr}="${escapeAttr(out)}"`
    })
  }

  const html = (text, inject) => {
    const b = BASE_RE.exec(text)
    if (b) {
      try {
        base = new URL(decodeEntities(b[1] ?? b[2] ?? b[3]).trim(), pageUrl).href
      } catch {}
    }
    let out = text.replace(TOKEN_RE, (m, blockTag, blockAttrs, body, plainTag, plainAttrs) => {
      if (m.startsWith("<!--")) return m
      if (blockTag) {
        const attrs = tag(blockTag, blockAttrs) ?? blockAttrs
        let content = body
        if (blockTag.toLowerCase() === "style") content = css(body)
        else if (/importmap/i.test(getAttr(blockAttrs, "type") || "")) content = importMap(body)
        return `<${blockTag}${attrs}>${content}</${blockTag}>`
      }
      const attrs = tag(plainTag, plainAttrs)
      return attrs === null ? "" : `<${plainTag}${attrs}>`
    })
    if (inject) {
      // ページのどのスクリプトよりも先に実行されるよう <head> の直後に入れる
      const open =
        /<head\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(out) ||
        /<html\b(?:[^>"']|"[^"]*"|'[^']*')*>/i.exec(out) ||
        /<!doctype[^>]*>/i.exec(out)
      const at = open ? open.index + open[0].length : 0
      out = out.slice(0, at) + INJECT_TAG + out.slice(at)
    }
    return out
  }

  return { html, css }
}

// =========================
// エラー応答
// =========================
function sendError(res, err) {
  if (res.headersSent) return res.destroy()
  const code = err?.code || err?.cause?.code || err?.errno
  let status = 502
  let message = "Upstream request failed"
  if (code === "EPRIVATE") {
    status = 403
    message = "Access to private network addresses is blocked"
  } else if (err?.name === "AbortError") {
    status = 504
    message = "Upstream timed out"
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    message = "Host not found"
  } else if (code === "ECONNREFUSED") {
    message = "Connection refused"
  } else if (code && String(code).startsWith("ERR_TLS") || /certificate/i.test(err?.message || "")) {
    message = "TLS/certificate error"
  }
  res.status(status).type("text/plain; charset=utf-8").send(`Science proxy: ${message}`)
}

// =========================
// メインのプロキシ処理
// =========================
async function proxyHandler(req, res) {
  const parsed = parseTarget(req.originalUrl.slice(PREFIX.length))
  if (!parsed) return res.status(400).type("text/plain").send("Science proxy: invalid target URL")
  // 正規形式にリダイレクト (307 で POST の中身も保持)
  if (!parsed.canonical) return res.redirect(307, PREFIX + parsed.url.href)

  const target = parsed.url
  if (target.protocol === "ws:" || target.protocol === "wss:") target.protocol = target.protocol === "ws:" ? "http:" : "https:"

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT)
  res.on("close", () => controller.abort())

  let upstream
  try {
    assertPublicHost(target)
    upstream = await fetch(target.href, {
      method: req.method,
      headers: buildUpstreamHeaders(req, target),
      // リクエストボディは加工せずそのままストリーム転送 (フォーム・ファイルアップロード対応)
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
      redirect: "manual",
      compress: false,
      agent: pickAgent,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    // ブラウザ側が接続を切っただけの場合はログに出さない
    if (!res.destroyed) console.error(`[proxy] ${target.href.slice(0, 120)}: ${err.code || err.message.slice(-120)}`)
    return sendError(res, err)
  }
  clearTimeout(timer)

  res.status(upstream.status)
  copyResponseHeaders(upstream, res, target, req.secure)

  const contentType = upstream.headers.get("content-type") || ""
  const encoding = upstream.headers.get("content-encoding")
  const length = upstream.headers.get("content-length")
  const noBody = req.method === "HEAD" || [101, 204, 205, 304].includes(upstream.status)
  const kind = /text\/html|application\/xhtml\+xml/i.test(contentType)
    ? "html"
    : /text\/css/i.test(contentType)
      ? "css"
      : null

  if (kind && !noBody && !(Number(length) > MAX_REWRITE_BYTES)) {
    let raw
    try {
      raw = Buffer.from(await upstream.arrayBuffer())
    } catch (err) {
      return sendError(res, err)
    }
    let decoded = null
    try {
      decoded = await decompress(raw, encoding)
    } catch {}
    if (decoded) {
      const text = decodeText(decoded, detectCharset(contentType, decoded, kind))
      const rewriter = createRewriter(target.href)
      const mime = contentType.split(";")[0].trim()
      res.setHeader("content-type", `${mime}; charset=utf-8`)
      if (kind === "html") {
        res.append("set-cookie", `${ORIGIN_COOKIE}=${encodeURIComponent(target.origin)}; Path=/; SameSite=Lax`)
        return sendText(req, res, rewriter.html(text, true))
      }
      return sendText(req, res, rewriter.css(text))
    }
    // 解凍できなかった場合はそのまま返す
    if (encoding) res.setHeader("content-encoding", encoding)
    res.setHeader("content-length", raw.length)
    return res.end(raw)
  }

  // 画像・動画・JS などはそのままストリーム転送 (Range リクエスト/動画シーク対応)
  if (encoding) res.setHeader("content-encoding", encoding)
  if (length) res.setHeader("content-length", length)
  if (noBody) {
    upstream.body?.resume?.()
    return res.end()
  }
  pipeline(upstream.body, res, () => {})
}

// =========================
// 取りこぼし救済
// =========================
// ページの JS が "/api/..." のようにプロキシ外へリクエストした場合、
// Referer (または直前のサイトの cookie) から本来の宛先を推測して転送する
function leakRedirect(req, res, next) {
  if (req.path === "/sw.js") return next()
  let base = fromProxyUrl(req.headers.referer)
  const isHome = req.path === "/" || req.path === "/index.html"
  if (!base && !isHome && req.headers["sec-fetch-dest"] !== "document") {
    const saved = readCookie(req.headers.cookie, ORIGIN_COOKIE)
    if (saved) {
      try {
        base = new URL(decodeURIComponent(saved))
      } catch {}
    }
  }
  if (!base) return next()
  res.redirect(307, PREFIX + new URL(req.originalUrl, base.origin).href)
}

// =========================
// WebSocket
// =========================
const wss = new WebSocketServer({
  noServer: true,
  handleProtocols: (protocols, req) => req.upstreamProtocol || false,
})

function bridge(client, upstream, pending) {
  const closeCode = code =>
    code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : undefined
  const relay = (from, to) => {
    from.on("close", (code, reason) => {
      if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) {
        const c = closeCode(code)
        c ? to.close(c, reason) : to.close()
      }
    })
    from.on("error", () => to.terminate())
  }
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
  })
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  for (const [data, isBinary] of pending) client.send(data, { binary: isBinary })
  relay(client, upstream)
  relay(upstream, client)
}

function handleUpgrade(req, socket, head) {
  socket.on("error", () => {})
  const parsed = req.url.startsWith(PREFIX) ? parseTarget(req.url.slice(PREFIX.length)) : null
  if (!parsed) return socket.destroy()

  const target = new URL(parsed.url.href)
  if (target.protocol === "http:") target.protocol = "ws:"
  if (target.protocol === "https:") target.protocol = "wss:"
  try {
    assertPublicHost(target)
  } catch {
    return socket.destroy()
  }

  const saved = readCookie(req.headers.cookie, ORIGIN_COOKIE)
  let origin = `${target.protocol === "wss:" ? "https:" : "http:"}//${target.host}`
  try {
    if (saved) origin = new URL(decodeURIComponent(saved)).origin
  } catch {}

  const protocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
  const headers = { origin }
  if (req.headers["user-agent"]) headers["user-agent"] = req.headers["user-agent"]
  if (req.headers["accept-language"]) headers["accept-language"] = req.headers["accept-language"]
  const cookie = upstreamCookieHeader(req.headers.cookie)
  if (cookie) headers.cookie = cookie

  const upstream = new WebSocket(target.href, protocols, {
    headers,
    lookup: guardedLookup,
    handshakeTimeout: UPSTREAM_TIMEOUT,
    perMessageDeflate: true,
  })
  const pending = []
  const queue = (data, isBinary) => pending.push([data, isBinary])
  upstream.on("message", queue)
  const fail = () => {
    upstream.terminate()
    socket.destroy()
  }
  upstream.once("error", fail)
  upstream.once("unexpected-response", (r, response) => {
    response.resume()
    fail()
  })
  socket.once("close", () => {
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  })
  upstream.once("open", () => {
    upstream.off("error", fail)
    req.upstreamProtocol = upstream.protocol
    wss.handleUpgrade(req, socket, head, client => {
      upstream.off("message", queue)
      bridge(client, upstream, pending)
    })
  })
}

// =========================
// サーバー起動
// =========================
const app = express()
app.disable("x-powered-by")
app.set("trust proxy", true)

app.all(`${PREFIX}*`, (req, res) => {
  proxyHandler(req, res).catch(err => {
    console.error(err)
    sendError(res, err)
  })
})
app.use(leakRedirect)
app.use(express.static(path.join(__dirname, "public")))
app.use((req, res) => res.status(404).type("text/plain").send("Not found"))

// 大きな cookie / ヘッダーを使うサイト (YouTube など) 向けに上限を引き上げる
if (http.maxHeaderSize < 65536) {
  console.warn("[warn] Start with `npm start` (node --max-http-header-size=81920) for sites with large headers")
}
const server = http.createServer({ maxHeaderSize: 81920 }, app)
server.on("upgrade", handleUpgrade)
server.listen(PORT, () => {
  console.log("running on " + PORT)
})
