<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project conventions

## API rate limiting

Every new API handler must pass an explicit `rateLimit: 200` to the `api()` wrapper (requests per minute, keyed by user id or IP):

```ts
export const GET = api({ rateLimit: 200 }, async (ctx) => { ... });
```

Never use `api(undefined, ...)` — handlers without an explicit limit are unthrottled for unauthenticated callers. Stricter values (10/20/30) are reserved for sensitive operations like login and payment verification; don't loosen existing limits.
