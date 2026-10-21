import { describe, expect, test } from 'bun:test'
import { parseLoginForm } from '../contract/harness'

/**
 * The form of a login of an identity provider.
 *
 * A provider that is not the fixture of the tests serves a form of its own:
 * dex asks for a login and a password. The tests drive a real provider the
 * way a browser does, so the form has to be read.
 */
describe('the form of a login of an identity provider', () => {
  test('the action of the form is found', () => {
    const form = parseLoginForm(
      '<form method="post" action="/dex/auth/local?back=%2Fdex%2Fauth%2Fcallback">' +
        '<input type="hidden" name="login" value="alice@shuttle.test" />' +
        '<input type="password" name="password" id="password" />' +
        '</form>'
    )
    expect(form).not.toBeNull()
    expect(form!.action).toBe('/dex/auth/local?back=%2Fdex%2Fauth%2Fcallback')
    // The field that carries the login is already filled in, and the
    // password is not: the field without a value is the one the test
    // fills in.
    expect(form!.fields).toEqual({ login: 'alice@shuttle.test' })
  })

  test('a page without a form is not a form', () => {
    expect(parseLoginForm('<html><body>no form here</body></html>')).toBeNull()
  })
})
