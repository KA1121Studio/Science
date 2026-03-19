import express from "express"
import { createProxyMiddleware } from "http-proxy-middleware"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

app.use("/proxy", (req, res, next) => {

  let target = req.query.url

  if (!target || !/^https?:\/\//i.test(target)) {
    return res.status(400).send("invalid url")
  }

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    secure: false
  })

  proxy(req, res, next)
})

app.listen(PORT, () => {
  console.log("running on " + PORT)
})
