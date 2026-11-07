// ==============================================================================
//  Sakhi Sahayak — Authentication, Token Session & Rate Limiting Module
// ==============================================================================
const crypto = require('crypto');

// In-memory revocation cache / fallback for dev & tests
const inMemoryRevokedTokens = new Set();

function getDb() {
  try {
    return require('./db');
  } catch {
    return null;
  }
}

/**
 * Validate and retrieve the active JWT signing secret.
 * Enforces strict security:
 * - Production REQUIRES process.env.JWT_SECRET (min 32 characters)
 * - Fails fast at startup in production if secret is missing or weak
 * - Supports dual-secret rotation via JWT_SECRET_PREVIOUS
 */
function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable is missing in production. Startup aborted for security.');
    }
    // In local dev/test, warn and use an ephemeral process-scoped key
    if (!global.__DEV_JWT_SECRET) {
      console.warn('⚠️ [Auth] JWT_SECRET unset in non-production. Generated ephemeral process key.');
      global.__DEV_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    }
    return global.__DEV_JWT_SECRET;
  }

  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('FATAL: JWT_SECRET must be at least 32 characters long in production.');
  }

  return secret;
}

/**
 * Get rotation secrets to support zero-downtime key rotation.
 */
function getVerificationSecrets() {
  const primary = getJwtSecret();
  const previous = process.env.JWT_SECRET_PREVIOUS;
  if (previous && previous !== primary) {
    return [primary, previous];
  }
  return [primary];
}

/**
 * Constant-time string equality check to protect against timing attacks.
 */
function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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
  const secret = getJwtSecret();
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Date.now() + expiresInDays * 24 * 60 * 60 * 1000;
  const jti = crypto.randomUUID(); // Unique token identifier

  const payload = {
    jti,
    userId: user.id || user.phone,
    phone: user.phone,
    name: user.name,
    exp
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${data}.${signature}`;
}

/**
 * Hash a token to store in the revocation registry.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Check if a token has been revoked.
 * Checks PostgreSQL revoked_tokens table, falling back to memory cache.
 */
async function isTokenRevoked(token) {
  const tokenHash = hashToken(token);
  if (inMemoryRevokedTokens.has(tokenHash)) return true;

  const db = getDb();
  if (db && db.isDatabaseConfigured()) {
    try {
      const record = await db.prisma.revokedToken.findUnique({
        where: { tokenHash }
      });
      if (record) {
        inMemoryRevokedTokens.add(tokenHash);
        return true;
      }
    } catch (err) {
      console.warn('⚠️ [Auth] Revoked token DB check warning:', err.message);
    }
  }

  return false;
}

/**
 * Revoke a token (e.g. on logout or security invalidation).
 * Persists hash into PostgreSQL and local cache.
 */
async function revokeToken(token) {
  if (!token || typeof token !== 'string') return;
  const tokenHash = hashToken(token);
  inMemoryRevokedTokens.add(tokenHash);

  const payload = verifyToken(token, { ignoreRevocation: true });
  const expiresAt = payload?.exp ? new Date(payload.exp) : new Date(Date.now() + 7 * 86400000);

  const db = getDb();
  if (db && db.isDatabaseConfigured()) {
    try {
      await db.prisma.revokedToken.upsert({
        where: { tokenHash },
        create: { tokenHash, expiresAt },
        update: {}
      });
      console.log(`[Auth] 🔒 Token revoked and persisted: ${tokenHash.slice(0, 12)}...`);
    } catch (err) {
      console.error('❌ [Auth] Failed to persist revoked token to DB:', err.message);
    }
  }
}

/**
 * Verifies an HMAC-SHA256 session token.
 * Returns decoded payload if valid and unrevoked, null otherwise.
 */
function verifyToken(token, options = {}) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;

  // Validate signature against current and rotation secrets using constant-time comparison
  const secrets = getVerificationSecrets();
  let signatureValid = false;

  for (const secret of secrets) {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    if (constantTimeEquals(signature, expectedSignature)) {
      signatureValid = true;
      break;
    }
  }

  if (!signatureValid) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired
    }

    if (!options.ignoreRevocation) {
      const tokenHash = hashToken(token);
      if (inMemoryRevokedTokens.has(tokenHash)) {
        return null; // Revoked in cache
      }
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
async function requireAuth(req, res, next) {
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

  const revoked = await isTokenRevoked(token);
  if (revoked) {
    return res.status(401).json({
      success: false,
      error: 'Session token has been revoked. Please log in again.'
    });
  }

  req.user = payload;
  req.token = token;
  next();
}

/**
 * Optional authentication middleware:
 * Attaches user payload if valid token provided, otherwise continues anonymously.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (payload && !(await isTokenRevoked(token))) {
      req.user = payload;
      req.token = token;
    } else {
      req.user = null;
    }
  } else {
    req.user = null;
  }
  next();
}

/**
 * Sliding window in-memory rate limiter.
 */
function createRateLimiter(maxRequests = 20, windowMs = 15 * 60 * 1000) {
  const requests = new Map();

  // Periodic cleanup
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of requests.entries()) {
      const filtered = timestamps.filter(t => now - t < windowMs);
      if (filtered.length === 0) {
        requests.delete(key);
      } else {
        requests.set(key, filtered);
      }
    }
  }, 60000).unref();

  return (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown-client';
    const now = Date.now();
    const timestamps = requests.get(ip) || [];
    const validTimestamps = timestamps.filter(t => now - t < windowMs);

    if (validTimestamps.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests. Please try again later.'
      });
    }

    validTimestamps.push(now);
    requests.set(ip, validTimestamps);
    next();
  };
}

module.exports = {
  getJwtSecret,
  generateToken,
  verifyToken,
  revokeToken,
  isTokenRevoked,
  requireAuth,
  optionalAuth,
  createRateLimiter,
  constantTimeEquals
};
