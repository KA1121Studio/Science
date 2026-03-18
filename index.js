import express from "express"
import puppeteer from "puppeteer-core"
import chromium from "@sparticuz/chromium"

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.static("public"))

let browser

async function initBrowser() {
  browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true
  })
}

app.get("/proxy", async (req, res) => {

  const url = req.query.url

  if (!url) {
    res.send("url parameter required")
    return
  }

  // URLバリデーション追加
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).send("invalid url")
  }

  if (url.includes("localhost") || url.includes("127.0.0.1")) {
    return res.status(403).send("forbidden")
  }

  if (!browser) {
    res.status(503).send("browser not ready")
    return
  }

  let page

  try {

    page = await browser.newPage()

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36"
    )

    await page.setCacheEnabled(true)

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000
    })

    let html = await page.content()

    // baseタグ注入
    html = html.replace(
      "<head>",
      `<head><base href="${url}">`
    )

    res.send(html)

  } catch (err) {

    res.status(500).send("Proxy Error: " + err.message)

  } finally {
    if (page) await page.close()
  }

})

async function start() {
  await initBrowser()
  app.listen(PORT, () => {
    console.log("running on " + PORT)
  })
}

start()
