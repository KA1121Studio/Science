import express from "express"
import fetch from "node-fetch"
import { URL } from "url"

const app = express()
const PORT = process.env.PORT || 3000

// 🔥 body対応（POSTなど）
app.use(express.raw({ type: "*/*" }))

app.use(express.static("public"))

app.get("/proxy/*", async (req, res) => {
  try {
    const raw = req.params[0]
    const targetUrl = decodeURIComponent(raw)
    const urlObj = new URL(targetUrl)

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        ...req.headers,
        host: urlObj.host,
        origin: urlObj.origin,
        referer: urlObj.href,
        cookie: req.headers.cookie || ""
      },
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? req.body
          : undefined
    })

    const contentType = response.headers.get("content-type") || ""

    // 🔥 HTMLだけ書き換え
    if (contentType.includes("text/html")) {
      let body = await response.text()

      // --- fetch / XHR フック ---
      const inject = `
<script>
(function(){
const originalFetch = window.fetch;
window.fetch = function(input, init){
  try{
    let url = typeof input === "object" ? input.url : input;
    const absolute = new URL(url, location.href).href;
    const proxied = "/proxy/" + encodeURIComponent(absolute);

    if(typeof input === "object"){
      input = new Request(proxied, input);
    } else {
      input = proxied;
    }
  }catch(e){}
  return originalFetch(input, init);
};

const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url){
  try{
    const absolute = new URL(url, location.href).href;
    url = "/proxy/" + encodeURIComponent(absolute);
  }catch(e){}
  return open.call(this, method, url);
};
})();
</script>
`

      body = body.replace("</head>", inject + "</head>")

      // --- URL書き換え ---
      body = body.replace(
        /(src|href|action)=["'](.*?)["']/gi,
        (m, attr, link) => {
          try {
            if (
              link.startsWith("data:") ||
              link.startsWith("#") ||
              link.startsWith("javascript:")
            ) return m

            const absolute = new URL(link, targetUrl).href
            return `${attr}="/proxy/${encodeURIComponent(absolute)}"`
          } catch {
            return m
          }
        }
      )

      // 🔥 CSP解除
      res.removeHeader("content-security-policy")
      res.removeHeader("content-security-policy-report-only")
      res.removeHeader("x-frame-options")
      res.removeHeader("x-content-type-options")

      // 🔥 cookie返却
      const cookies = response.headers.raw()["set-cookie"]
      if (cookies) {
        res.setHeader("set-cookie", cookies)
      }

      res.setHeader("content-type", contentType)
      res.send(body)
      return
    }

    // 🔥 HTML以外はストリーミング（最重要）
    res.status(response.status)

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return
      res.setHeader(key, value)
    })

    const cookies = response.headers.raw()["set-cookie"]
    if (cookies) {
      res.setHeader("set-cookie", cookies)
    }

    response.body.pipe(res)

  } catch (e) {
    console.error(e)
    res.status(500).send("proxy error")
  }
})

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
