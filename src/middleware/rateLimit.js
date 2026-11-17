import { rateLimit } from 'express-rate-limit';
const limiter = (windowMs, limit, options = {}) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...options,
  });
export function createRateLimits() {
  return {
    hold: limiter(60 * 60 * 1000, 10),
    checkout: limiter(60 * 60 * 1000, 30),
    login: limiter(15 * 60 * 1000, 5),
    preview: limiter(15 * 60 * 1000, 5, {
      skipSuccessfulRequests: true,
      skip: (req) => !req.headers.authorization,
    }),
    contact: limiter(60 * 60 * 1000, 5),
    availability: limiter(60 * 1000, 120),
  };
}
