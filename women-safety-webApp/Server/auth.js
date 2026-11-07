// ==============================================================================
//  Sakhi Sahayak — Authentication, Token Session & Rate Limiting Module
// ==============================================================================
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'sakhi-session-secret-change-in-prod-xyz123!';

/**
 * Base64 URL encode
 */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Base64 URL decode
 */
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) {
    str += '=';
  }
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Generates an HMAC-SHA256 signed session token.
 * Valid for 7 days by default.
 */
function generateToken(user, expiresInDays = 7) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;
  const payload = {
    userId: user.id || user.phone,
    phone: user.phone,
    name: user.name,
    exp
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 session token.
 * Returns decoded payload if valid, null otherwise.
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware requiring a valid session token.
 * Used to protect evidence management and sensitive operations.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required. Bearer token missing.'
    });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (!payload) {
    return res.status(401).json({
      success: false,
      error: 'Invalid or expired authentication session token.'
    });
  }

  req.user = payload;
  next();
}

/**
 * Optional authentication middleware:
 * Attaches user payload if valid token provided, otherwise continues anonymously.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    req.user = verifyToken(token);
  } else {
    req.user = null;
  }
  next();
}

/**
 * In-memory sliding-window rate limiter for sensitive endpoints.
 * @param {number} maxRequests - Max requests allowed in the window
 * @param {number} windowMs - Window duration in milliseconds
 */
function createRateLimiter(maxRequests = 10, windowMs = 15 * 60 * 1000) {
  const requests = new Map();

  return (req, res, next) => {
    // In automated unit tests, skip rate limiting
    if (process.env.NODE_ENV === 'test' && !req.headers['x-test-ratelimit']) {
      return next();
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const timestamps = requests.get(ip) || [];

    const activeTimestamps = timestamps.filter(t => now - t < windowMs);

    if (activeTimestamps.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.'
      });
    }

    activeTimestamps.push(now);
    requests.set(ip, activeTimestamps);
    next();
  };
}

module.exports = {
  generateToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  createRateLimiter
};
