self.addEventListener("install", event => {
  self.skipWaiting()
})

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", event => {
  const req = event.request
  const url = new URL(req.url)

  // 自分のサイトは除外
  if (url.origin === location.origin) return

  event.respondWith(
    fetch("/proxy?url=" + encodeURIComponent(req.url), {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" ? req.body : undefined
    }).catch(() => fetch(req))
  )
})
