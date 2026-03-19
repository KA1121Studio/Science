self.addEventListener("install", event => {
  self.skipWaiting()
})

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim())
})

function proxify(url) {
  try {
    if (url.startsWith("http")) {
      return "/proxy?url=" + encodeURIComponent(url)
    }
    return url
  } catch {
    return url
  }
}

self.addEventListener("fetch", event => {

  const req = event.request
  const url = new URL(req.url)

  // 自分のドメインはそのまま
  if (url.pathname.startsWith("/proxy")) {
    return
  }

  const target = req.url

  event.respondWith(
    fetch(proxify(target), {
      method: req.method,
      headers: req.headers,
      body: req.method !== "GET" ? req.body : undefined,
      redirect: "follow"
    }).catch(() => fetch(req))
  )
})
