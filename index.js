import express from "express"
import fetch from "node-fetch"
import { URL } from "url"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

app.get("/proxy/*", async (req, res) => {
  try {
    const raw = req.params[0]
    const targetUrl = decodeURIComponent(raw)

    // ❌ about:blank防止
    if (targetUrl.startsWith("about:")) {
      return res.status(400).send("invalid url")
    }

    const urlObj = new URL(targetUrl)

    const response = await fetch(targetUrl, {
      headers: {
        "user-agent": req.headers["user-agent"] || ""
      }
    })

    const contentType = response.headers.get("content-type") || ""

    // =========================
    // 🧠 HTMLだけ加工
    // =========================
    if (contentType.includes("text/html")) {
      let body = await response.text()

      body = body.replace(
        "<head>",
        `<head><base href="/proxy/${targetUrl}">`
      )

      const inject = `
<script>
(function(){
const originalFetch = window.fetch;
window.fetch = function(input, init){
  try{
    let url = typeof input === "object" ? input.url : input;
    if(url.startsWith("about:")) return originalFetch(input, init);

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
    if(url.startsWith("about:")) return open.call(this, method, url);

    const absolute = new URL(url, location.href).href;
    url = "/proxy/" + encodeURIComponent(absolute);
  }catch(e){}
  return open.call(this, method, url);
};
})();
</script>
`

      body = body.replace("</head>", inject + "</head>")

      body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
        try {
          if (
            link.startsWith("data:") ||
            link.startsWith("#") ||
            link.startsWith("javascript:") ||
            link.startsWith("about:")
          ) return m

          const absolute = new URL(link, targetUrl).href
          return `${attr}="/proxy/${encodeURIComponent(absolute)}"`
        } catch {
          return m
        }
      })

      res.setHeader("content-type", contentType)
      res.send(body)
      return
    }

    // =========================
    // 🎨 CSSは書き換え
    // =========================
    if (contentType.includes("text/css")) {
      let body = await response.text()

      body = body.replace(/url\((.*?)\)/g, (m, url) => {
        url = url.replace(/["']/g, "")
        try {
          const absolute = new URL(url, targetUrl).href
          return `url("/proxy/${encodeURIComponent(absolute)}")`
        } catch {
          return m
        }
      })

      res.setHeader("content-type", contentType)
      res.send(body)
      return
    }

    // =========================
    // 🔥 JS・画像・その他は全部stream
    // =========================
    res.setHeader("content-type", contentType)
    response.body.pipe(res)

  } catch (e) {
    console.error(e)
    res.status(500).send("proxy error")
  }
})

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
