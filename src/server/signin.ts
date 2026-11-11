// The dashboard's sign-in: a page that asks for the admin token, and the
// cookie a browser keeps once it gives the right one. The cookie holds an
// HMAC of the admin token rather than the token, so changing the token signs
// every browser out.
import { createHmac } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const SESSION = 'sherpa_session'
const MONTH = 30 * 24 * 60 * 60

export const sessionOf = (admin: string) => createHmac('sha256', admin).update('sherpa dashboard session').digest('hex')

export function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at !== -1 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim()
  }
  return null
}

/**
 * Lax: a link to the dashboard from another site opens it signed in, while a
 * request another site's page makes, such as a fetch or a form post, goes
 * without it. Secure behind a TLS proxy.
 */
export function sessionCookie(req: IncomingMessage, value: string | null): string {
  const secure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as { encrypted?: boolean }).encrypted ? '; Secure' : ''
  return `${SESSION}=${value ?? ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value ? MONTH : 0}${secure}`
}

export const SIGNIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Sign in · Sherpa</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #111113; color: #9d9da1; font-size: 14px; line-height: 1.5; }
  main { width: min(360px, calc(100vw - 32px)); }
  .brand { display: flex; align-items: center; gap: 8px; color: #ececee; font-size: 13px; font-weight: 600; margin-bottom: 28px; }
  .mark { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 5px; background: color-mix(in srgb, #22b8d8 14%, transparent); color: #22b8d8; font-size: 9px; font-weight: 700; }
  h1 { margin: 0 0 6px; color: #ececee; font-size: 20px; font-weight: 600; }
  p { margin: 0; }
  form { margin-top: 20px; display: grid; gap: 8px; }
  label { color: #ececee; font-size: 13px; font-weight: 500; }
  input { font: 13px 'SF Mono', ui-monospace, Menlo, Consolas, monospace; color: #ececee; background: #1a1a1d; border: 1px solid rgba(255,255,255,.13); border-radius: 8px; padding: 9px 10px; outline: none; }
  input:focus { border-color: #22b8d8; box-shadow: 0 0 0 3px color-mix(in srgb, #22b8d8 25%, transparent); }
  button { margin-top: 4px; font: inherit; font-weight: 600; color: #0b2a31; background: #22b8d8; border: 0; border-radius: 8px; padding: 9px 12px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #error { min-height: 21px; color: #f87171; font-size: 13px; }
  .hint { margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,.08); font-size: 13px; }
  code { white-space: nowrap; font: 12px 'SF Mono', ui-monospace, Menlo, Consolas, monospace; color: #ececee; background: rgba(255,255,255,.07); border-radius: 4px; padding: 1px 5px; }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="mark" aria-hidden="true">S</span>Sherpa</div>
  <h1>Sign in</h1>
  <p>The dashboard takes the admin token.</p>
  <form id="form">
    <label for="token">Admin token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" spellcheck="false" required autofocus>
    <button id="submit">Sign in</button>
    <p id="error" role="alert"></p>
  </form>
  <p class="hint">It’s <code>SHERPA_ADMIN_TOKEN</code> in the <code>.env</code> file next to <code>docker-compose.yml</code>. To print it, run <code>grep ADMIN .env</code> in that folder.</p>
</main>
<script>
  const form = document.getElementById('form'), input = document.getElementById('token'), button = document.getElementById('submit'), error = document.getElementById('error')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    button.disabled = true
    error.textContent = ''
    const res = await fetch('/signin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: input.value.trim() }) }).catch(() => null)
    if (res && res.ok) return location.reload()
    const body = res && (await res.json().catch(() => null))
    error.textContent = res ? (body && body.message) || 'sherpa-server answered ' + res.status + '.' : 'sherpa-server didn’t answer. Is it running?'
    button.disabled = false
    input.select()
  })
</script>
</body>
</html>
`
