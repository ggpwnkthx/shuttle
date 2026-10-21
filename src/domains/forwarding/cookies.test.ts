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

  test('the quotes of a value are delimiters and not part of it', () => {
    expect(parseCookieHeader('app="hello world"')).toEqual({ app: 'hello world' })
  })

  test('the escapes of a value are decoded', () => {
    expect(parseCookieHeader('app=a%20b')).toEqual({ app: 'a b' })
  })

  test('a value that carries an equal sign is a value', () => {
    expect(parseCookieHeader('app=b=c')).toEqual({ app: 'b=c' })
  })

  test('a value that cannot be decoded is kept as it is', () => {
    expect(parseCookieHeader('app=%E0%A4%A')).toEqual({ app: '%E0%A4%A' })
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
    expect(parseCookieHeader('=value')).toEqual({ '': 'value' })
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
