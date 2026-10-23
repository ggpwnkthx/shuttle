import { describe, expect, test } from 'bun:test'
import { cookieNameOf, parseCookieHeader, renderCookieHeader } from './index'

/**
 * The parsing of the cookies.
 *
 * The format is the one of the specification, so the edge cases are the
 * ones of the standard: a quoted value, a value that carries an escape or
 * an `=`, a name that appears twice.
 */
describe('the cookies of a request', () => {
  test('a cookie is a name and a value', () => {
    expect(parseCookieHeader('app=1; other=2')).toEqual({ app: '1', other: '2' })
  })

  test('a header that is absent carries no cookie', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
  })

  test.each([
    ['the quotes of a value are delimiters and not part of it', 'app="hello world"', 'hello world'],
    ['the escapes of a value are decoded', 'app=a%20b', 'a b'],
    ['a value that carries an equal sign is a value', 'app=b=c', 'b=c'],
    ['a value that cannot be decoded is kept as it is', 'app=%E0%A4%A', '%E0%A4%A'],
  ])('%s', (_case, header, value) => {
    expect(parseCookieHeader(header)).toEqual({ app: value })
  })

  test('the first value of a name that appears twice is the one of the caller', () => {
    // A browser sends the cookie of the longest path first, so the first
    // value is the one of the most specific cookie.
    expect(parseCookieHeader('shuttle_session=first; shuttle_session=second')).toEqual({
      shuttle_session: 'first',
    })
  })

  test('the name of a cookie is case sensitive', () => {
    expect(parseCookieHeader('Shuttle_Session=secret')).toEqual({ Shuttle_Session: 'secret' })
  })

  test('a malformed header is not an error', () => {
    // The name of a cookie is read as it is: the header is not refused.
    // The rendering is what drops the name that the standard does not
    // allow, so a client cannot break the gateway with a malformed header.
    expect(parseCookieHeader('a b=1')).toEqual({ 'a b': '1' })
  })

  test('a pair without a name is not a cookie', () => {
    // The standard does not allow an empty name, and the rendering drops
    // such a pair. The parser drops it as well, so that what the gateway
    // reads is what it forwards.
    expect(parseCookieHeader('=value')).toEqual({})
    expect(parseCookieHeader('a=1; =2')).toEqual({ a: '1' })
  })

  test('the control characters are removed from the values', () => {
    // A value that carries one is a value that no browser sent: it would
    // end up in a comparison with a session id or with the state of a
    // login.
    expect(parseCookieHeader('a=%00')).toEqual({ a: '' })
    expect(parseCookieHeader('a=x%0Ay')).toEqual({ a: 'xy' })
    // A name that carries one is not a name: the cookie is dropped.
    expect(parseCookieHeader('a\tb=1')).toEqual({})
  })

  test('the cookies are rendered in the order of the object', () => {
    expect(renderCookieHeader({ app: '1', other: '2' })).toBe('app=1; other=2')
  })

  test('a header without a cookie is empty', () => {
    expect(renderCookieHeader({})).toBe('')
  })

  test('a cookie that cannot be rendered is not rendered', () => {
    // The other cookies of the header are rendered: a cookie of another
    // site does not cost the caller its own cookies.
    expect(renderCookieHeader({ 'a b': '1' })).toBe('')
    expect(renderCookieHeader({ 'a b': '1', app: '2' })).toBe('app=2')
    expect(renderCookieHeader({ app: '2', 'a b': '1' })).toBe('app=2')
  })
})

describe('the name of a cookie of an answer', () => {
  test('the name is the one in front of the first equal sign', () => {
    expect(cookieNameOf('shuttle_session=abc')).toBe('shuttle_session')
    expect(cookieNameOf('shuttle_session=abc; Path=/; HttpOnly')).toBe('shuttle_session')
  })

  test('a value that carries an equal sign does not change the name', () => {
    expect(cookieNameOf('shuttle_session=a=b')).toBe('shuttle_session')
  })

  test('an expiry that carries a comma does not change the name', () => {
    expect(cookieNameOf('shuttle_session=abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT')).toBe(
      'shuttle_session'
    )
  })

  test('a value that carries no equal sign is a name without a value', () => {
    // It is not a valid cookie, but it has to be recognized as one: a
    // malformed cookie of the gateway does not reach the browser.
    expect(cookieNameOf('shuttle_session')).toBe('shuttle_session')
    expect(cookieNameOf('=value')).toBe('')
  })
})
