import express from "express"
import fetch from "node-fetch"
import * as cheerio from "cheerio"
import https from "https"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

const agent = new https.Agent({
  rejectUnauthorized: false
})

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

app.use(express.static(join(__dirname, "public")))

app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "public/index.html"))
})

app.use("/proxy/:targetUrl*", async (req, res) => {
  try {

    let targetBase = decodeURIComponent(req.params.targetUrl)

    if (!targetBase.startsWith("http"))
      targetBase = "https://" + targetBase

    const subPath = req.params[0] || ""
    const query = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : ""

    const fullTarget =
      targetBase +
      (subPath.startsWith("/") ? "" : "/") +
      subPath +
      query

    const response = await fetch(fullTarget, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",

        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",

        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",

        "Accept-Encoding": "identity",

        "Cache-Control": "no-cache",
        "Pragma": "no-cache",

        "Upgrade-Insecure-Requests": "1",

        // 追加ヘッダー
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",

        // Cookieはそのまま渡す
        "Cookie": req.headers.cookie || ""
      },

      redirect: "follow", // ←重要
      agent
    })

    const setCookie = response.headers.raw()["set-cookie"]
    if (setCookie) res.setHeader("set-cookie", setCookie)

    const contentType =
      response.headers.get("content-type")?.toLowerCase() || ""

    // バイナリそのまま
    if (!contentType.includes("text/html")) {
      res.status(response.status)
      response.body.pipe(res)
      return
    }

    let body = await response.text()

    const $ = cheerio.load(body, { decodeEntities: false })

    function rewriteUrl(url) {
      if (!url) return url

      if (/^(data:|blob:|javascript:|about:|#)/i.test(url))
        return url

      if (url.startsWith("//"))
        url = "https:" + url

      try {
        const abs = new URL(url, fullTarget).href
        return "/proxy/" + encodeURIComponent(abs)
      } catch {
        return url
      }
    }

    const attrs = [
      ["img", "src"],
      ["script", "src"],
      ["link", "href"],
      ["a", "href"],
      ["iframe", "src"],
      ["source", "src"],
      ["video", "src"],
      ["audio", "src"],
      ["form", "action"]
    ]

    attrs.forEach(([tag, attr]) => {
      $(tag).each((i, el) => {
        const v = $(el).attr(attr)
        if (!v) return
        $(el).attr(attr, rewriteUrl(v))
      })
    })

    // srcset対応
    $("[srcset]").each((i, el) => {
      const srcset = $(el).attr("srcset")
      if (!srcset) return

      const parts = srcset.split(",")

      const newParts = parts.map(p => {
        const seg = p.trim().split(/\s+/)
        seg[0] = rewriteUrl(seg[0])
        return seg.join(" ")
      })

      $(el).attr("srcset", newParts.join(", "))
    })

    function rewriteCss(css) {
      return css.replace(/url\(['"]?([^'")]+)['"]?\)/gi, (m, u) => {
        return "url(" + rewriteUrl(u) + ")"
      })
    }

    $("style").each((i, el) => {
      $(el).html(rewriteCss($(el).html()))
    })

    $("[style]").each((i, el) => {
      $(el).attr("style", rewriteCss($(el).attr("style")))
    })

    // meta refresh
    $("meta[http-equiv='refresh']").each((i, el) => {
      const c = $(el).attr("content")
      if (!c) return

      const m = c.match(/url=(.*)/i)
      if (!m) return

      $(el).attr("content", "0; url=" + rewriteUrl(m[1]))
    })

    $("base").remove()

    // JSフック改善版
    const script = `
<script>
(function(){

function toProxy(u){
  if(!u) return u
  if(/^(data:|blob:|javascript:|#)/i.test(u)) return u

  try{
    const abs=new URL(u,location.href).href
    if(abs.includes('/proxy/')) return u
    return '/proxy/'+encodeURIComponent(abs)
  }catch{
    return u
  }
}

// クリック
document.addEventListener('click',function(e){
  const a=e.target.closest('a[href]')
  if(!a) return

  const href=a.getAttribute('href')
  if(!href || href.startsWith('#')) return

  if(!href.startsWith('/proxy/')){
    e.preventDefault()
    location.href=toProxy(href)
  }
},true)

// fetch
const _fetch = window.fetch
window.fetch = function(input, init){
  let url = input
  if(typeof input === 'object') url = input.url

  return _fetch(toProxy(url), init)
}

// xhr
const open = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function(m,u){
  return open.call(this, m, toProxy(u))
}

// history
const push = history.pushState
history.pushState = function(s,t,u){
  if(u) u = toProxy(u)
  return push.call(this,s,t,u)
}

})()
</script>
`

    $("head").prepend(script)

    body = $.html()

    const headers = {}

    response.headers.forEach((v, k) => {
      const key = k.toLowerCase()

      if (
        ![
          "content-length",
          "content-encoding",
          "transfer-encoding",
          "content-security-policy",
          "content-security-policy-report-only",
          "x-frame-options"
        ].includes(key)
      ) headers[k] = v
    })

    headers["access-control-allow-origin"] = "*"

    res.set(headers)
    res.status(response.status).send(body)

  } catch (err) {
    res.status(500).send("Proxy Error<br>" + err.message)
  }
})

app.listen(PORT, () => {
  console.log("Proxy running " + PORT)
})
