import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'pkdemo_auth';

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Optional HTTP basic auth for the whole site (pages, state socket and VNC sockets).
 * The remote browsers are interactive, so a public deployment should always set a password.
 *
 * After a successful basic-auth request, a cookie derived from the credentials is set, because
 * browsers do not reliably resend basic-auth credentials on WebSocket upgrades.
 */
export function createBasicAuth({ username, password }) {
  const enabled = password.length > 0;
  const expected = `${username}:${password}`;
  const cookieToken = createHmac('sha256', expected).update('pkdemo-session').digest('base64url');

  function hasValidHeader(headers) {
    const match = /^Basic (.+)$/i.exec(headers.authorization ?? '');
    return Boolean(match) && safeEqual(Buffer.from(match[1], 'base64').toString('utf8'), expected);
  }

  function hasValidCookie(headers) {
    const token = readCookie(headers.cookie, COOKIE_NAME);
    return token !== null && safeEqual(token, cookieToken);
  }

  function isAuthorized(headers) {
    return !enabled || hasValidHeader(headers) || hasValidCookie(headers);
  }

  function middleware(req, res, next) {
    if (!enabled) return next();
    if (hasValidHeader(req.headers)) {
      if (!hasValidCookie(req.headers)) {
        const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
        res.cookie(COOKIE_NAME, cookieToken, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
      }
      return next();
    }
    if (hasValidCookie(req.headers)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Passkeys demo", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  }

  return { enabled, isAuthorized, middleware };
}
