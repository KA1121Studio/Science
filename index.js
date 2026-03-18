import express from "express"
import puppeteer from "puppeteer"

const app = express()
const PORT = 3000

let browser

async function initBrowser() {
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  })
}

app.get("/proxy", async (req, res) => {

  const url = req.query.url

  if (!url) {
    res.send("url parameter required")
    return
  }

  try {

    const page = await browser.newPage()

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36"
    )

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 0
    })

    const html = await page.content()

    await page.close()

    res.send(html)

  } catch (err) {

    res.status(500).send(err.message)

  }

})

app.listen(PORT, async () => {

  await initBrowser()

  console.log("puppeteer proxy running " + PORT)

})
