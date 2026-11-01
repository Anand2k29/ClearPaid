// Security controls for the server. Each one uses a standard, well-understood mechanism:
//   - Bearer token over TLS (RFC 6750), compared in constant time (crypto.timingSafeEqual).
//   - Content-Security-Policy, nosniff, frame denial and a restrictive Permissions-Policy (OWASP Secure Headers).
//   - Fixed-window rate limiting per client address, with 429 and Retry-After (RFC 6585).
//   - Error responses that never expose internal details or provider error bodies.
// Money never moves through this server. PayPal holds the card and bank data, so this app has no PCI card scope.
const crypto = require("node:crypto");

const MIN_TOKEN_LENGTH = 32;

// Compares two strings without leaking their contents through timing. Hashing first gives equal lengths.
function tokensMatch(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b) && given.length === expected.length;
}

// Returns null when the request is authorised, or a reason string when it is not.
function checkBearer(req, expectedToken) {
  if (!expectedToken || expectedToken.length < MIN_TOKEN_LENGTH) return "server access token is not configured";
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return "missing bearer token";
  return tokensMatch(match[1].trim(), expectedToken) ? null : "invalid bearer token";
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "worker-src 'self' blob: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join("; ");

function setSecurityHeaders(res, { api = false } = {}) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  if (api) res.setHeader("Cache-Control", "no-store");
}

// Fixed-window limiter: at most `max` requests per `windowMs` for each key.
function createRateLimiter({ max = 60, windowMs = 60000, now = () => Date.now() } = {}) {
  const windows = new Map();
  return {
    // Returns { allowed, retryAfterSec }.
    hit(key) {
      const t = now();
      const w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        windows.set(key, { start: t, count: 1 });
        return { allowed: true, retryAfterSec: 0 };
      }
      w.count += 1;
      if (w.count > max) {
        return { allowed: false, retryAfterSec: Math.ceil((w.start + windowMs - t) / 1000) };
      }
      return { allowed: true, retryAfterSec: 0 };
    },
    size() {
      return windows.size;
    }
  };
}

// Public message for an error. Client errors (4xx) keep their short validation text.
// Server and provider errors get a generic message, so PayPal or AI error bodies never reach the browser.
function publicError(err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 400 && status < 500) return { status, message: err.message };
  const upstream = [502, 503, 504].includes(status) ? status : 500;
  return { status: upstream, message: "The request could not be completed. Please try again." };
}

module.exports = { MIN_TOKEN_LENGTH, tokensMatch, checkBearer, setSecurityHeaders, createRateLimiter, publicError, CSP };
