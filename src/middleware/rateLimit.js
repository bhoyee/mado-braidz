import { rateLimit } from 'express-rate-limit';
const limiter = (windowMs, limit) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
export function createRateLimits() {
  return {
    hold: limiter(60 * 60 * 1000, 10),
    login: limiter(15 * 60 * 1000, 5),
    contact: limiter(60 * 60 * 1000, 5),
    availability: limiter(60 * 1000, 120),
  };
}
