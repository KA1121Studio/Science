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
        "user-agent": req.headers["user-agent"] || "",
      }
    })

    const contentType = response.headers.get("content-type") || ""

    // =========================
    // 🖼 画像・動画はそのまま返す
    // =========================
    if (!contentType.includes("text/html")) {
      res.setHeader("content-type", contentType)
      response.body.pipe(res)
      return
    }

    // =========================
    // 🧠 HTMLだけ処理
    // =========================
    let body = await response.text()

    // baseタグ
    body = body.replace(
      "<head>",
      `<head><base href="/proxy/${targetUrl}">`
    )

    // fetchフック
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

    // URL書き換え（安全版）
    body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
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
    })

    // CSP解除
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
