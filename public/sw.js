// Science proxy Service Worker
// ページから漏れたリクエスト (外部 URL や "/api" のようなルート相対 URL) を捕まえて
// プロキシ経由に直す安全網
const PREFIX = "/proxy/"
const ORIGIN = self.location.origin

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))

const fixScheme = s => s.replace(/^(https?|wss?):\/+/i, (m, p) => p + "://")

// プロキシ URL -> 本来の URL
function targetFrom(href) {
  if (!href) return null
  try {
    const u = new URL(href)
    if (u.origin !== ORIGIN || !u.pathname.startsWith(PREFIX)) return null
    return new URL(fixScheme((u.pathname + u.search).slice(PREFIX.length)))
  } catch {
    return null
  }
}

// リクエスト元のページが表示しているサイト
async function pageTarget(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId)
    const t = client && targetFrom(client.url)
    if (t) return t
  }
  return targetFrom(event.request.referrer)
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (url.origin === ORIGIN && (url.pathname.startsWith(PREFIX) || url.pathname === "/sw.js")) return
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  event.respondWith(handle(event, url))
})

async function handle(event, url) {
  const req = event.request
  const page = await pageTarget(event)
  // プロキシ中のページ以外 (トップページなど) からのリクエストは素通し
  if (!page) return fetch(req)

  const dest = url.origin === ORIGIN ? new URL(url.pathname + url.search, page.origin) : url
  const proxied = ORIGIN + PREFIX + dest.href

  // ページ移動はリダイレクト (アドレスバーの URL も正しくなる / 307 で POST を保持)
  if (req.mode === "navigate") return Response.redirect(proxied, req.method === "GET" ? 302 : 307)

  const init = {
    method: req.method,
    headers: req.headers,
    credentials: "include",
    redirect: "follow",
  }
  if (req.cache !== "only-if-cached") init.cache = req.cache
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer()
  try {
    return await fetch(proxied, { ...init, referrer: req.referrer || "about:client" })
  } catch {
    return fetch(proxied, init)
  }
}
