import express from "express"
import { createProxyMiddleware } from "http-proxy-middleware"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

/* =========================
   JS書き換え（通信フック）
========================= */
function injectScript(baseUrl) {
  return `
<script>
(function() {
  const base = "${baseUrl}";

  function proxify(url) {
    try {
      if (!url) return url;

      if (url.startsWith("data:") || url.startsWith("blob:")) return url;

      if (url.startsWith("http")) {
        return "/proxy?url=" + encodeURIComponent(url);
      }

      return "/proxy?url=" + encodeURIComponent(new URL(url, base).href);
    } catch(e) {
      return url;
    }
  }

  // fetch
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === "string") {
      input = proxify(input);
    } else if (input && input.url) {
      input = new Request(proxify(input.url), input);
    }
    return originalFetch(input, init);
  };

  // XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return origOpen.call(this, method, proxify(url), ...rest);
  };

  // WebSocket
  const OrigWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    return new OrigWebSocket(proxify(url), protocols);
  };

  // location操作
  const origAssign = window.location.assign;
  window.location.assign = function(url) {
    return origAssign.call(window.location, proxify(url));
  };

})();
</script>
`
}

/* =========================
   HTML書き換え
========================= */
function rewriteHtml(body, baseUrl) {
  return body
    .replace("<head>", `<head><base href="${baseUrl}">${injectScript(baseUrl)}`)
    .replace(/(href|src)=["']\//g, `$1="/proxy?url=${baseUrl}/`)
    .replace(/(href|src)=["'](https?:\/\/[^"']+)["']/g,
      (m, attr, url) => `${attr}="/proxy?url=${url}"`
    )
}

/* =========================
   プロキシ本体
========================= */
app.use("/proxy", (req, res, next) => {

  let target = req.query.url

  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("invalid url")
  }

  // SSRF対策（最低限）
  if (target.includes("localhost") || target.includes("127.0.0.1")) {
    return res.status(403).send("blocked")
  }

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    selfHandleResponse: true,

    onProxyReq(proxyReq) {
      proxyReq.setHeader("User-Agent", "Mozilla/5.0")
    },

    onProxyRes(proxyRes, req, res) {

      const type = proxyRes.headers["content-type"] || ""

      // リダイレクト修正
      if (proxyRes.headers.location) {
        proxyRes.headers.location =
          "/proxy?url=" + proxyRes.headers.location
      }

      // HTMLだけ書き換え
      if (type.includes("text/html")) {

        let body = Buffer.from([])

        proxyRes.on("data", chunk => {
          body = Buffer.concat([body, chunk])
        })

        proxyRes.on("end", () => {
          const html = body.toString("utf-8")
          const fixed = rewriteHtml(html, target)
          res.send(fixed)
        })

      } else {
        proxyRes.pipe(res)
      }
    }
  })

  proxy(req, res, next)
})

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
