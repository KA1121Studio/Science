self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)

  // 自分のサーバーはスルー
  if (url.pathname.startsWith("/proxy/")) return

  const proxiedUrl = "/proxy/" + encodeURIComponent(event.request.url)

  const init = {
    method: event.request.method,
    headers: new Headers(event.request.headers),
    credentials: "include"
  }

  // bodyはGET/HEAD以外だけ
  if (!["GET", "HEAD"].includes(event.request.method)) {
    init.body = event.request.clone().body
  }

  event.respondWith(fetch(proxiedUrl, init))
})
