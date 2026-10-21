import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chromium, type Browser } from 'playwright'
import { createHarness, type Harness } from '../contract/harness'

/**
 * The behaviour of the gateway in a real browser.
 *
 * The cookies, the redirects and the origins are the contract between the
 * gateway and the browser: a test that speaks http does not see what a
 * browser does with the cookies and with the origin of a page.
 *
 * The page of the other site runs on another port of the loopback
 * address: it is another origin of the same site, exactly like a sibling
 * subdomain of the platform is.
 */

/** The host of the gateway in the tests. */
const GATEWAY_HOST = 'localhost'

/** The port of the gateway. */
function portOf(url: string): number {
  return Number(new URL(url).port)
}

/** The timeout of the tests of the browser. */
const TIMEOUT = 30_000

describe('the gateway in a browser', () => {
  let harness: Harness
  let browser: Browser
  let evil: { url: string; stop: () => Promise<void> }

  beforeAll(async () => {
    harness = await createHarness({
      routes: (context) => [
        {
          id: 'browser-site',
          match: { host: '*', path: '/' },
          upstream: context.upstreamA,
          auth: { mode: 'none' },
        },
        {
          id: 'browser-socket',
          match: { host: '*', path: '/socket/' },
          upstream: context.upstreamA,
          auth: { mode: 'any' },
          websocket: true,
        },
      ],
    })

    // The page of another site: it tries to change the state of the gateway
    // and to open a websocket with the cookie of the browser.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        const url = new URL(request.url)
        const gateway = `http://${GATEWAY_HOST}:${portOf(harness.gatewayUrl)}`
        if (url.pathname === '/post') {
          // The form sends the browser to the gateway: the answer of the
          // gateway is what the browser shows.
          return new Response(
            `<!doctype html><html><body>
              <form method="post" action="${gateway}/">
                <button type="submit">go</button>
              </form>
            </body></html>`,
            { headers: { 'content-type': 'text/html' } }
          )
        }
        if (url.pathname === '/socket') {
          return new Response(
            `<!doctype html><html><body><script>
              const socket = new WebSocket('ws://${GATEWAY_HOST}:${portOf(harness.gatewayUrl)}/socket/')
              socket.onopen = () => { document.title = 'open' }
              socket.onerror = () => { document.title = 'refused' }
              socket.onclose = () => { document.title = 'closed' }
            </script></body></html>`,
            { headers: { 'content-type': 'text/html' } }
          )
        }
        return new Response('<!doctype html><html><body>the other site</body></html>', {
          headers: { 'content-type': 'text/html' },
        })
      },
    })
    evil = {
      url: `http://${GATEWAY_HOST}:${server.port}`,
      stop: async () => {
        await server.stop(true)
      },
    }

    browser = await chromium.launch({ args: ['--no-sandbox'] })
  })

  afterAll(async () => {
    await browser?.close()
    await evil?.stop()
    await harness?.stop()
  })

  test(
    'the browser signs in and the cookie has the attributes of the specification',
    async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const gateway = `http://${GATEWAY_HOST}:${portOf(harness.gatewayUrl)}`

      // The browser follows the login flow: the gateway, the provider and the
      // page of the provider.
      await page.goto(`${gateway}/auth/login?redirect=%2F`)
      await page.waitForSelector('input[name="password"]', { timeout: TIMEOUT })
      await page.selectOption('select[name="email"]', 'alice@shuttle.test')
      await page.fill('input[name="password"]', 'alice-password')
      await Promise.all([
        page.waitForURL(`${gateway}/`, { timeout: TIMEOUT }),
        page.click('button[type="submit"]'),
      ])

      const cookies = await context.cookies(gateway)
      const session = cookies.find((cookie) => cookie.name === 'shuttle_session')
      expect(session).toBeDefined()
      expect(session?.httpOnly).toBe(true)
      expect(session?.sameSite).toBe('Lax')
      expect(session?.path).toBe('/')
      // The deployment of the tests is not served over tls.
      expect(session?.secure).toBe(false)
      // The state of the login is not left behind.
      expect(cookies.find((cookie) => cookie.name === 'shuttle_oidc_state')).toBeUndefined()
      await context.close()
    },
    TIMEOUT
  )

  test(
    'a form of another site that changes the state is refused',
    async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const gateway = `http://${GATEWAY_HOST}:${portOf(harness.gatewayUrl)}`

      // The browser is signed in: the cookie of the session is in its jar.
      await page.goto(`${gateway}/auth/login?redirect=%2F`)
      await page.waitForSelector('input[name="password"]', { timeout: TIMEOUT })
      await page.selectOption('select[name="email"]', 'alice@shuttle.test')
      await page.fill('input[name="password"]', 'alice-password')
      await Promise.all([
        page.waitForURL(`${gateway}/`, { timeout: TIMEOUT }),
        page.click('button[type="submit"]'),
      ])

      await page.goto(`${evil.url}/post`)
      await Promise.all([
        page.waitForURL(`${gateway}/`, { timeout: TIMEOUT }),
        page.click('button[type="submit"]'),
      ])
      const body = JSON.parse((await page.textContent('body')) ?? '{}') as { error: string }
      // The request carries the cookie of the session (the origins are of the
      // same site) and it comes from another origin: the gateway refuses it.
      expect(body.error).toBe('cross_site_request')
      await context.close()
    },
    TIMEOUT
  )

  test(
    'a websocket from another site is refused',
    async () => {
      const context = await browser.newContext()
      const page = await context.newPage()
      const gateway = `http://${GATEWAY_HOST}:${portOf(harness.gatewayUrl)}`

      await page.goto(`${gateway}/auth/login?redirect=%2F`)
      await page.waitForSelector('input[name="password"]', { timeout: TIMEOUT })
      await page.selectOption('select[name="email"]', 'alice@shuttle.test')
      await page.fill('input[name="password"]', 'alice-password')
      await Promise.all([
        page.waitForURL(`${gateway}/`, { timeout: TIMEOUT }),
        page.click('button[type="submit"]'),
      ])

      await page.goto(`${evil.url}/socket`)
      await page.waitForFunction(() => document.title.length > 0, undefined, { timeout: TIMEOUT })
      const title = await page.title()
      // The handshake was refused: the connection was never opened.
      expect(title).not.toBe('open')
      await context.close()
    },
    TIMEOUT
  )
})
