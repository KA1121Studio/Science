import express from "express"
import { createProxyMiddleware } from "http-proxy-middleware"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

function rewriteHtml(body, baseUrl) {
  return body
    .replace(/(href|src)=["']\//g, `$1="/proxy?url=${baseUrl}/`)
    .replace(/(href|src)=["'](https?:\/\/[^"']+)["']/g, (match, attr, url) => {
      return `${attr}="/proxy?url=${url}"`
    })
}

app.use("/proxy", (req, res, next) => {

  let target = req.query.url
  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("invalid url")
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

      const contentType = proxyRes.headers["content-type"] || ""

      // 🔁 リダイレクト修正
      if (proxyRes.headers["location"]) {
        proxyRes.headers["location"] =
          "/proxy?url=" + proxyRes.headers["location"]
      }

      // HTMLだけ書き換え
      if (contentType.includes("text/html")) {

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
