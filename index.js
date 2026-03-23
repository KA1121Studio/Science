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
    const urlObj = new URL(targetUrl)

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "user-agent": req.headers["user-agent"] || ""
      }
    })

    let body = await response.text()
    const contentType = response.headers.get("content-type") || ""

    // 🔥 HTML処理
    if (contentType.includes("text/html")) {

      // baseタグ
      body = body.replace(
        "<head>",
        `<head><base href="/proxy/${targetUrl}">`
      )

      // fetchフック注入
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

      // src / href 書き換え
      body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
        try {
          const absolute = new URL(link, targetUrl).href
          return `${attr}="/proxy/${encodeURIComponent(absolute)}"`
        } catch {
          return m
        }
      })
    }

    // 🔥 JS処理（簡易）
    if (contentType.includes("javascript")) {
      body = body.replace(
        /fetch\((.*?)\)/g,
        (match, url) => {
          return `fetch("/proxy/" + encodeURIComponent(new URL(${url}, "${targetUrl}").href))`
        }
      )
    }

    // 🔥 CSP解除
    res.removeHeader("content-security-policy")
    res.removeHeader("x-frame-options")

    res.setHeader("content-type", contentType)
    res.send(body)

  } catch (e) {
    console.error(e)
    res.status(500).send("proxy error")
  }
})

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
