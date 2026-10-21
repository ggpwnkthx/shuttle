import { describe, expect, test } from 'bun:test'
import { decodeHtmlEntities, parseLoginForm } from '../contract/harness'

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

  test('the entities of the action are decoded', () => {
    // The action of the form of dex carries two parameters, and html
    // writes the `&` between them as `&amp;`. A form that is submitted
    // with the entity left in place loses the `state` of the login, and
    // dex refuses the login with a `400`.
    const form = parseLoginForm(
      '<form method="post" action="/dex/auth/local/login?back=&amp;state=ruhd2pl5j6lwzaiwd2urtawqx">' +
        '<input tabindex="1" required id="login" name="login" type="text" />' +
        '</form>'
    )
    expect(form).not.toBeNull()
    expect(form!.action).toBe('/dex/auth/local/login?back=&state=ruhd2pl5j6lwzaiwd2urtawqx')
  })

  test('the entities of a value are decoded', () => {
    expect(decodeHtmlEntities('a &amp; b')).toBe('a & b')
    expect(decodeHtmlEntities('&lt;script&gt;')).toBe('<script>')
    expect(decodeHtmlEntities('&quot;q&quot;')).toBe('"q"')
    expect(decodeHtmlEntities('&#39;')).toBe("'")
    expect(decodeHtmlEntities('&#65;')).toBe('A')
    expect(decodeHtmlEntities('&#x41;')).toBe('A')
    // The `&amp;` is decoded last: `&amp;lt;` is the text `&lt;` and not
    // the character `<`.
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;')
  })
})
