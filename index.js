import express from "express"
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

app.use("/proxy", createProxyMiddleware({
  changeOrigin: true,
  secure: false,
  selfHandleResponse: true,

  router: (req) => {
    return req.query.url
  },

  onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {

    const contentType = proxyRes.headers["content-type"] || ""

    // 🔐 URL検証（安全対策）
    try {
      const parsed = new URL(req.query.url)
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return "invalid protocol"
      }
    } catch {
      return "invalid url"
    }

    // 🌐 HTMLを書き換え（リンク完全プロキシ化）
    if (contentType.includes("text/html")) {
      let body = responseBuffer.toString("utf8")

      body = body.replace(/(href|src)=["'](.*?)["']/gi, (match, attr, url) => {

        // すでにプロキシ済み or データURLはスキップ
        if (
          url.startsWith("/proxy") ||
          url.startsWith("data:") ||
          url.startsWith("#")
        ) return match

        // 絶対URL
        if (url.startsWith("http")) {
          return `${attr}="/proxy?url=${encodeURIComponent(url)}"`
        }

        // 相対URL → 元URLと結合
        try {
          const base = new URL(req.query.url)
          const absolute = new URL(url, base).href
          return `${attr}="/proxy?url=${encodeURIComponent(absolute)}"`
        } catch {
          return match
        }
      })

      return body
    }

    return responseBuffer
  })
}))

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
