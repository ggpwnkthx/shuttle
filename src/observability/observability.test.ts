import { describe, expect, test } from 'bun:test'
import { MetricsStore, createLogger, redactFields, redactUrl } from './index'

/**
 * The observation of the gateway.
 *
 * The logs of the gateway carry the credentials of the callers and the
 * tokens of the providers; they must never reach the log stream. The
 * metrics carry the routes of the deployment; they must never grow without
 * limit.
 */

describe('the redaction of the logs', () => {
  test('the credential headers are redacted', () => {
    const fields = redactFields({
      authorization: 'Bearer secret-token',
      cookie: 'shuttle_session=abc',
      'set-cookie': 'shuttle_session=abc',
      'x-api-key': 'the-key',
      route: 'workspace-api',
    })
    expect(fields.authorization).toBe('[redacted]')
    expect(fields.cookie).toBe('[redacted]')
    expect(fields['set-cookie']).toBe('[redacted]')
    expect(fields['x-api-key']).toBe('[redacted]')
    // The fields that are not credentials are kept.
    expect(fields.route).toBe('workspace-api')
  })

  test('the credentials of a nested field are redacted as well', () => {
    const fields = redactFields({
      request: { headers: { authorization: 'Bearer secret' }, method: 'GET' },
    }) as { request: { headers: Record<string, string>; method: string } }
    expect(fields.request.headers.authorization).toBe('[redacted]')
    expect(fields.request.method).toBe('GET')
  })

  test('a bearer token of a message is removed', () => {
    const fields = redactFields({ error: 'the token Bearer abc.def-ghi was refused' })
    expect(String(fields.error)).not.toContain('abc.def-ghi')
    expect(String(fields.error)).toContain('[redacted]')
  })

  test('the token bearing query parameters are redacted', () => {
    const url = '/auth/callback?code=the-code&state=the-state&id_token=the-token&page=2'
    const redacted = redactUrl(url)
    expect(redacted).not.toContain('the-code')
    expect(redacted).not.toContain('the-state')
    expect(redacted).not.toContain('the-token')
    // The parameters that carry no token are kept.
    expect(redacted).toContain('page=2')
  })

  test('an absolute url keeps its shape', () => {
    const redacted = redactUrl('https://api.example.com/ws?access_token=secret&x=1')
    expect(redacted.startsWith('https://api.example.com/ws')).toBe(true)
    expect(redacted).not.toContain('secret')
  })

  test('the logger writes the redacted fields', () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line) })
    logger.info('the request was refused', {
      authorization: 'Bearer secret-token',
      requestId: 'req-1',
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('secret-token')
    expect(lines[0]).toContain('req-1')
  })
})

describe('the labels of the metrics', () => {
  test('the routes beyond the cap are aggregated', () => {
    const metrics = new MetricsStore()
    for (let index = 0; index < 600; index++) {
      metrics.recordRequest({
        routeId: `route-${index}`,
        method: 'GET',
        status: 200,
        durationMs: 1,
        bytesIn: 1,
        bytesOut: 1,
      })
    }
    return metrics.render().then((body) => {
      // The series of the routes are bounded: the routes that do not fit any
      // more are aggregated into one.
      const series = body.split('\n').filter((line) => line.startsWith('shuttle_requests_total{'))
      const routes = new Set(series.map((line) => /route="([^"]*)"/.exec(line)?.[1] ?? ''))
      expect(routes.size).toBeLessThanOrEqual(501)
      expect(routes.has('overflow')).toBe(true)
    })
  })

  test('the metrics of a request are counted', async () => {
    const metrics = new MetricsStore()
    metrics.requestStarted()
    metrics.recordRequest({
      routeId: 'workspace-api',
      method: 'GET',
      status: 200,
      durationMs: 12,
      bytesIn: 100,
      bytesOut: 200,
    })
    metrics.requestFinished()
    const body = await metrics.render()
    expect(body).toContain(
      'shuttle_requests_total{route="workspace-api",method="GET",status="200"}'
    )
    expect(body).toContain('shuttle_bytes_in_total 100')
    expect(body).toContain('shuttle_bytes_out_total 200')
    // The gauge of the requests that are in flight is back to zero.
    expect(body).toContain('shuttle_active_requests 0')
  })

  test('the labels never carry a workspace, a subject or an url', async () => {
    const metrics = new MetricsStore()
    metrics.recordAuthFailure('workspace-api', 'access_denied')
    metrics.recordWebsocketRefusal('cross_site')
    const body = await metrics.render()
    expect(body).toContain(
      'shuttle_auth_failures_total{route="workspace-api",reason="access_denied"}'
    )
    expect(body).toContain('shuttle_websocket_refusals_total{reason="cross_site"}')
    // There is no label that could carry the identity of a caller.
    expect(body).not.toContain('workspaceId')
    expect(body).not.toContain('subject')
  })
})
