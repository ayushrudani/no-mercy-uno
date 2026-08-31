/**
 * Which credential a request presents.
 *
 * Worth testing directly because the precedence has been wrong before, in both
 * directions: the server preferred the cookie over an explicit Authorization
 * header and broke the forced password change, and the client sent no header
 * at all and broke session restore over plain HTTP on the bare IP.
 */

import { describe, expect, it } from 'vitest';
import { requestHeaders } from '../src/lib/api.js';

describe('requestHeaders', () => {
  it('sends the stored session token', () => {
    expect(requestHeaders({ hasBody: false, token: 'abc' })).toEqual({
      Authorization: 'Bearer abc',
    });
  });

  it('sends nothing when signed out', () => {
    expect(requestHeaders({ hasBody: false, token: null })).toEqual({});
  });

  it('adds the content type only when there is a body', () => {
    expect(requestHeaders({ hasBody: true, token: null })).toEqual({
      'Content-Type': 'application/json',
    });
    expect(requestHeaders({ hasBody: false, token: null })['Content-Type']).toBeUndefined();
  });

  /** The reset token must beat the session it is about to replace. */
  it('lets an explicit Authorization override the stored token', () => {
    const headers = requestHeaders({
      hasBody: true,
      token: 'session-token',
      explicit: { Authorization: 'Bearer reset-token' },
    });
    expect(headers.Authorization).toBe('Bearer reset-token');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('keeps other explicit headers', () => {
    const headers = requestHeaders({
      hasBody: false,
      token: 'abc',
      explicit: { 'X-Test': '1' },
    });
    expect(headers).toEqual({ Authorization: 'Bearer abc', 'X-Test': '1' });
  });

  it('does not mutate what it is given', () => {
    const explicit = { 'X-Test': '1' };
    requestHeaders({ hasBody: true, token: 'abc', explicit });
    expect(explicit).toEqual({ 'X-Test': '1' });
  });
});
