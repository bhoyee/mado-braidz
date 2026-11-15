# AGENTS.md
You are building the Mado African Braidz booking platform.
The full product spec is docs/SPEC.md. Read it before every task. It wins over your assumptions.

Rules:
- Stack is fixed: Node.js 20 LTS, Express 4, Nunjucks SSR, Tailwind CSS v4 (built at build time), Alpine.js, MySQL 8 via Drizzle ORM + mysql2, Stripe Checkout + webhooks. No Next.js, no React SPA, no Redis, no Docker in production.
- Target host is shared cPanel hosting (Phusion Passenger). No long-running workers; background work runs from cron via `node scripts/run-jobs.js`.
- All money is stored as integer cents. All times stored in UTC; displayed in America/New_York.
- Never trust prices from the client. Always recompute totals on the server.
- Every booking state change goes through `src/services/bookingService.js`.
- Write tests (Vitest + Supertest) for booking, slot locking, pricing and webhooks.
- Follow the design system in docs/SPEC.md Section 4. Do not use generic template layouts, gradient blobs, glassmorphism, emoji icons, or stock "three feature cards" sections.
- Work only on the milestone you're given. List anything out of scope under "Follow-ups" in your summary.
- Update README.md (setup, env vars, deploy steps) whenever you add config.