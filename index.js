
import express from "express"
import fetch from "node-fetch"
import { URL } from "url"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 🔒 proxy以外禁止
app.use((req, res, next) => {
  if (!req.path.startsWith("/proxy/")) {
    return res.status(403).send("Use proxy only")
  }
  next()
})

app.all("/proxy/*", async (req, res) => {
  try {
    const raw = req.params[0]
    const targetUrl = decodeURIComponent(raw)
    const urlObj = new URL(targetUrl)

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "user-agent": req.headers["user-agent"] || "",
        "cookie": req.headers["cookie"] || "",
        "content-type": req.headers["content-type"] || "",
        "authorization": req.headers["authorization"] || "",
        "accept": req.headers["accept"] || "",
        "accept-language": req.headers["accept-language"] || "",
        "referer": urlObj.origin
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : JSON.stringify(req.body),
      redirect: "manual"
    })

    // 🔁 リダイレクト対応
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (location) {
        const absolute = new URL(location, targetUrl).href
        return res.redirect("/proxy/" + encodeURIComponent(absolute))
      }
    }

    const contentType = response.headers.get("content-type") || ""

    // 🍪 cookie返却
    const setCookie = response.headers.raw()["set-cookie"]
    if (setCookie) {
      res.setHeader("set-cookie", setCookie)
    }

    // 📦 バイナリ対応
    const isText =
      contentType.includes("text") ||
      contentType.includes("javascript") ||
      contentType.includes("json")

    if (!isText) {
      const buffer = await response.arrayBuffer()
      res.setHeader("content-type", contentType)
      return res.send(Buffer.from(buffer))
    }

    let body = await response.text()

    // =========================
    // HTML処理
    // =========================
    if (contentType.includes("text/html")) {

      const base = `/proxy/${encodeURIComponent(targetUrl)}`
      body = body.replace("<head>", `<head><base href="${base}">`)

      const inject = `
<script>
(function(){
const proxy = (url) => "/proxy/" + encodeURIComponent(url);

// =================
// fetch
// =================
const originalFetch = window.fetch;
window.fetch = function(input, init){
  try{
    let url = typeof input === "object" ? input.url : input;
    const absolute = new URL(url, location.href).href;
    const proxied = proxy(absolute);

    if(typeof input === "object"){
      input = new Request(proxied, input);
    } else {
      input = proxied;
    }
  }catch(e){}
  return originalFetch(input, init);
};

// =================
// XHR
// =================
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return open.call(this, method, url);
};

// =================
// location制御
// =================
const assign = window.location.assign;
window.location.assign = function(url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return assign.call(this, url);
};

const replace = window.location.replace;
window.location.replace = function(url){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return replace.call(this, url);
};

// =================
// aタグ強制
// =================
document.addEventListener("click", function(e){
  const a = e.target.closest("a");
  if(!a) return;

  const href = a.getAttribute("href");
  if(!href || href.startsWith("javascript:")) return;

  try{
    const absolute = new URL(href, location.href).href;
    a.href = proxy(absolute);
  }catch(e){}
});

// =================
// form強制
// =================
document.addEventListener("submit", function(e){
  const form = e.target;
  if(!form.action) return;

  try{
    const absolute = new URL(form.action, location.href).href;
    form.action = proxy(absolute);
  }catch(e){}
});

// =================
// WebSocket
// =================
const WS = window.WebSocket;
window.WebSocket = function(url, protocols){
  try{
    const absolute = new URL(url, location.href).href;
    url = proxy(absolute);
  }catch(e){}
  return new WS(url, protocols);
};

})();
</script>
`

      body = body.replace("</head>", inject + "</head>")

      // 🔗 リンク書き換え
      body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
        try {
          if (link.startsWith("data:") || link.startsWith("javascript:")) return m
          const absolute = new URL(link, targetUrl).href
          return attr + '="/proxy/' + encodeURIComponent(absolute) + '"'
        } catch {
          return m
        }
      })

      // iframe制限
      body = body.replace(/<iframe/gi, '<iframe sandbox="allow-scripts allow-forms"')
    }

    // 🔓 CSP解除＆再設定
    res.removeHeader("content-security-policy")
    res.removeHeader("x-frame-options")

    res.setHeader(
      "content-security-policy",
      "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'"
    )

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
