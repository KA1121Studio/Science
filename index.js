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
        "cookie": req.headers["cookie"] || ""
      },
      body:
        req.method !== "GET" && req.method !== "HEAD"
          ? req
          : undefined
    })

    let body = await response.text()
    const contentType = response.headers.get("content-type") || ""

    // Cookie返す
    const setCookie = response.headers.raw()["set-cookie"]
    if (setCookie) {
      res.setHeader("set-cookie", setCookie)
    }

    // 🔥 HTML処理
    if (contentType.includes("text/html")) {

      // baseタグ（修正済）
      body = body.replace(
        "<head>",
        `<head><base href="/proxy/${encodeURIComponent(targetUrl)}">`
      )

      // 🔥 スクリプト注入（完全囲い込み）
      const inject = `
<script>
(function(){

const wrap = (url)=>{
  try{
    const absolute = new URL(url, location.href).href;
    return "/proxy/" + encodeURIComponent(absolute);
  }catch(e){
    return url;
  }
};

// fetch
const originalFetch = window.fetch;
window.fetch = function(input, init){
  try{
    let url = typeof input === "object" ? input.url : input;
    const proxied = wrap(url);

    if(typeof input === "object"){
      input = new Request(proxied, input);
    } else {
      input = proxied;
    }
  }catch(e){}
  return originalFetch(input, init);
};

// XHR
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url){
  url = wrap(url);
  return open.call(this, method, url);
};

// location制御
const assign = window.location.assign;
window.location.assign = function(url){
  return assign.call(this, wrap(url));
};

const replace = window.location.replace;
window.location.replace = function(url){
  return replace.call(this, wrap(url));
};

// aタグクリック防止
document.addEventListener("click", function(e){
  const a = e.target.closest("a");
  if(a && a.href){
    e.preventDefault();
    location.href = wrap(a.href);
  }
});

})();
</script>
`

      body = body.replace("</head>", inject + "</head>")

      // src / href
      body = body.replace(/(src|href)=["'](.*?)["']/gi, (m, attr, link) => {
        try {
          const absolute = new URL(link, targetUrl).href
          return `${attr}="/proxy/${encodeURIComponent(absolute)}"`
        } catch {
          return m
        }
      })

      // form action
      body = body.replace(/action=["'](.*?)["']/gi, (m, link) => {
        try {
          const absolute = new URL(link, targetUrl).href
          return `action="/proxy/${encodeURIComponent(absolute)}"`
        } catch {
          return m
        }
      })

      // target="_blank" 無効化
      body = body.replace(/target=["']_blank["']/gi, "")

      // meta refresh
      body = body.replace(
        /http-equiv=["']refresh["'] content=["'](.*?)url=(.*?)["']/gi,
        (m, a, url) => {
          try {
            const absolute = new URL(url, targetUrl).href
            return `http-equiv="refresh" content="${a}url=/proxy/${encodeURIComponent(absolute)}"`
          } catch {
            return m
          }
        }
      )

      // iframe
      body = body.replace(/<iframe(.*?)src=["'](.*?)["']/gi, (m, pre, link) => {
        try {
          const absolute = new URL(link, targetUrl).href
          return \`<iframe\${pre}src="/proxy/\${encodeURIComponent(absolute)}"\`
        } catch {
          return m
        }
      })

      // CSS url()
      body = body.replace(/url\\(["']?(.*?)["']?\\)/gi, (m, link) => {
        try {
          const absolute = new URL(link, targetUrl).href
          return \`url("/proxy/\${encodeURIComponent(absolute)}")\`
        } catch {
          return m
        }
      })
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
