// Screenshots dashboard pages in the system Firefox and prints the pages'
// console warnings and errors. Usage:
//   node scripts/shoot.mjs http://127.0.0.1:5320 / /agents/1 [--widths 1280,390] [--wait 1500] [--out shots] [--frames 1] [--every 1000] [--token <admin token>]
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`)
	return i === -1 ? fallback : args[i + 1]
}
const flagged = new Set(args.flatMap((a, i) => (a.startsWith('--') ? [i, i + 1] : [])))
const [base, ...paths] = args.filter((_, i) => !flagged.has(i))
const widths = flag('widths', '1280,390').split(',').map(Number)
const wait = Number(flag('wait', 1500))
const out = flag('out', 'shots')
const frames = Number(flag('frames', 1))
const every = Number(flag('every', 1000))
const token = flag('token', null)

const browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX_PATH ?? '/usr/bin/firefox', headless: true })
const page = await browser.newPage()
// Without a token, sherpa-server shows its sign-in page
if (token) await page.setExtraHTTPHeaders({ authorization: `Bearer ${token}` })
const notes = []
page.on('console', (m) => {
	if (['warn', 'error'].includes(m.type())) notes.push(`${m.type()}: ${m.text()}`)
})
page.on('pageerror', (e) => notes.push(`pageerror: ${e.message}`))
mkdirSync(out, { recursive: true })

for (const path of paths.length ? paths : ['/']) {
	for (const width of widths) {
		await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
		await page.goto(new URL(path, base).href, { waitUntil: 'load' })
		await new Promise((r) => setTimeout(r, wait))
		const slug = path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'board'
		for (let n = 0; n < frames; n++) {
			const file = join(out, `${slug}-${width}${frames > 1 ? `-${n}` : ''}.png`)
			await page.screenshot({ path: file, fullPage: true })
			console.log(file)
			if (n < frames - 1) await new Promise((r) => setTimeout(r, every))
		}
	}
}
await browser.close()
console.log(notes.length ? `console:\n${[...new Set(notes)].join('\n')}` : 'console: no warnings or errors')
