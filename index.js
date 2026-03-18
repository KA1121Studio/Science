import express from "express"
import puppeteer from "puppeteer-core"
import chromium from "@sparticuz/chromium"

const app = express()
const PORT = process.env.PORT || 3000

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

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000
    })

    const html = await page.content()

    res.send(html)

  } catch (err) {

    res.status(500).send(err.message)

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
　
