# Changelog

## 0.5.3 — 2026-11-18

### Packaging

- `repository` and `bugs` now use the organization's canonical spelling (`Visdenda/agent-watch`).
  npm compares `repository.url` against the GitHub OIDC claim when a release is published with
  provenance, and the lowercase owner failed that check with `E422`. No runtime change.

## 0.5.2 — 2026-11-15

### Fixed

- A probe that shares an origin with the collector no longer reports itself. `send()` posts to
  `/v1/probe*`, and because that POST is not a browser navigation the wrapped handler used to see
  it, report it again, and recurse until the subrequest limit. Those three ingest paths are now
  skipped before any payload is built. Self-hosting the collector inside the same app (Visdenda's
  own Worker included) now needs no path exclusion in user code; a collector mounted elsewhere
  still has to be excluded by the caller.

## 0.5.1 — 2026-11-15

### Packaging

- Publish gates resolve `publint` and `attw` from `node_modules/.bin` instead of `pnpm exec`, so the
  public source mirror runs the same gates without a pnpm installation. No runtime change.

## 0.5.0 — 2026-11-12

### Changed (breaking; pre-1.0)

- The factory is `createAgentWatch({ token })`. `initVisdenda` is gone, and the configuration key
  is `token` (the `vdc_...` site token), not `site` — the wire field keeps the protocol name
  `site`. Payloads now carry `v: 2`; the collector accepts payloads without it as protocol 1.
- The package is split into request-shape entry points: `.`, `./workers` (`wrapFetch`), `./node`
  (`nodeMiddleware`), `./hono` (`contextMiddleware`), `./next` (`requestMiddleware`) and
  `./markdown`. The root entry exports only `createAgentWatch`, protocol types and the referrer
  helpers, so a Worker no longer bundles the Node adapter. The framework-named exports
  (`expressMiddleware`, `honoMiddleware`, `nextMiddleware`) and the aliases `wrapWorkerFetch` /
  `withAgentProbe` remain removed — the package has no framework or brand dependency.
- README and the docs page now include a PHP-FPM example and state why the probe takes a site
  token instead of a domain: a domain would let anyone post hits for any site and there would be
  no way to revoke a sender; the token is write-only and rotating it stops forged writes.
- Server-side identity verification is documented: a user agent is not proof. The collector now
  checks the vendor's published IP ranges (OpenAI, Anthropic, Perplexity, Google, Bing,
  DuckDuckGo, …) and forward-confirmed reverse DNS, and only marks a hit `unverified` when the
  official data says so. See "How crawler identity is verified" in the README.

## 0.4.1 — 2026-11-10

### Added

- `onError` and `debug: true` make report failures visible: network errors, timeouts and
  non-2xx responses were previously swallowed with no trace. `onError` receives
  `{ path, status?, error?, events? }`; `debug` warns once per instance with a pointer to
  `watch.check()`. `onError` wins when both are set, and a throwing callback is ignored.

### Performance

- Plain-object header lookups (Express/Fastify) take a direct lowercase-key hit instead of
  scanning and lowercasing every key for each of the ~13 header reads per event. Mixed-case
  keys still fall back to the case-insensitive scan.
- Batch mode serializes each event once at enqueue and assembles the `/v1/probe/batch` body
  from those strings, instead of measuring each event with one `JSON.stringify` at flush and
  then serializing the whole batch again.

### Packaging

- The published ESM/CJS bundles are minified. Raw `dist/index.mjs` drops from 15.9 kB to
  7.6 kB and the unpacked package from 116 kB to 81 kB; the tree-shaken runtime cost is
  unchanged (bundle size was already measured after minification).

## 0.4.0 — 2026-11-06

### Added

- Probe payload v2: `ref` (referrer), `utm` (fallback), `neg` (html/markdown), `dur` (handler
  time), `country`, `colo`, plus the `x-agent-watch` version header on every report.
- `trustProxy` — `x-forwarded-for` is only trusted when this is explicitly enabled; the default
  remains `cf-connecting-ip`.
- Optional batching (`batch: { maxEvents, flushMs }`, off by default) posting to
  `/v1/probe/batch`; a failed batch is dropped, never retried.
- `markdownNegotiation({ cache: { ttlMs } })` — optional Cache API reuse of converted Markdown
  (200 only, `Vary: Accept` and `private` kept on the stored copy, personalized responses skipped).
- AI-referrer navigations (`chatgpt.com`, `perplexity.ai`, `claude.ai`, …) are no longer skipped
  as browser navigations.
- `isAiReferrerHost` / `normalizeUtmSource` helpers, and `watch.flush()` for batching.

### Changed

- User agents over 512 characters are truncated instead of dropped; paths are truncated the same
  way (the server schema rejects, not truncates, so an over-long path used to drop the event).
- Machine files (`/robots.txt`, `/llms.txt`, sitemaps, `.md`) are reported like any other request;
  the server counts them separately from page crawls.
- The Markdown guide now states the required wrapper order: the probe must sit **outside** the
  Markdown middleware so it sees the final response and can report `neg`.

### Fixed

- Payload size limits are enforced client-side: `path` ≤ 512, IP ≤ 45 characters, and every batch
  is clamped to 50 events / 32 KB. Previously an over-long value made the collector answer 400/413,
  the SDK swallowed it, and the event disappeared with no trace.
- Batching: `maxEvents` / `flushMs` are clamped to the server contract, a batch is split by body
  size instead of being rejected as a whole, `waitUntil` is registered before a `maxEvents` flush,
  and concurrent flushes are serialised so an in-flight batch cannot be released early.
- `watch.check()` verifies a token against `/v1/probe/check` and distinguishes an invalid token
  from an unreachable collector, so a wiring mistake is diagnosable from inside the process.
  `watch.verify()` is the boolean form for a startup gate.
- Publishing from CI can opt into npm provenance with `AGENT_WATCH_PROVENANCE=true`
  (requires `id-token: write` and a public repository); local publishes are unaffected.
- Handlers that throw now report `status: 500` before rethrowing (`wrapFetch`, `withAgentProbe`,
  `honoMiddleware`); crawler hits on broken paths used to be invisible.
- Browser-navigation detection is engine-neutral (`sec-fetch-mode` + `sec-fetch-dest` + an HTML
  accept) instead of requiring Chromium client hints. Firefox and Safari page views were being
  reported as probe events and consumed the crawler event budget.
- Markdown cache hits keep `Vary: Accept` and carry `cache-control: max-age=<ttl>, private`;
  personalized origin responses are not cached at all. The previous stored copy dropped `vary`,
  which let an upstream CDN cache the Markdown variant under the bare URL.
- `markdownPaths` matching is documented precisely: `"/"` matches the home page only (prefixes
  match whole segments, so `/docs` does not match `/docs2`) — leave the option unset for the whole
  site, or write `["/", "/docs"]` for home plus a section.
- Express middleware attaches `finish` before calling `next()` and no longer sends the query
  string as `path`; Next middleware accepts an optional `waitUntil` callback.
- Country is also read from `x-vercel-ip-country` and Netlify's `x-nf-geo`; with `trustProxy`,
  `x-real-ip` / `true-client-ip` / `fly-client-ip` are accepted as IP sources.
- `dur` uses a monotonic clock, and the Markdown body read is capped while streaming instead of
  buffering an unbounded response. `./package.json` is exported for tooling.

### Packaging

- ESM and CJS consumers now get the matching declaration format: the `import` condition points at
  `.d.mts`, the `require` condition at `.d.ts`. 0.3.0 shipped one `.d.ts` for both, so an ESM
  consumer under `moduleResolution: node16`/`nodenext` saw CJS types over an ESM implementation
  (`publint` / `attw` FalseCJS).
- `typesVersions` maps the `./markdown` subpath for legacy `moduleResolution: node10`, where
  `exports` is ignored; 0.3.0 could not resolve that subpath at all in that mode.
- Relative imports in the published declarations use explicit `.js` specifiers, which is what
  makes the `.d.mts` / `.d.ts` split resolve correctly under both module systems.
- `pnpm check:package` is now a release gate: `publint`, `attw` (node10 / node16 CJS / node16 ESM /
  bundler) and an install smoke that packs the tarball and exercises ESM `import`, CJS `require`
  and a TypeScript `nodenext` compile. `publish:npm` runs the same gate before publishing.

## 0.3.0 — 2026-11-06

### Added

- `wrapFetch(config, handler)` — the fetch wrapper under a runtime-neutral name. It is the same
  function as `wrapWorkerFetch` (kept as a deprecated alias): Workers, Bun, Deno, Vercel Edge and
  Netlify Edge all hand you `Request`/`Response`, so there is no per-platform adapter to install.
- `markdownNegotiation().wrapFetch(...)` — same alias for the Markdown middleware.

### Docs

- The install guide is organised by **request shape** (fetch / Node `(req, res, next)` / Next
  middleware) instead of by framework, which is what kept "is there an adapter for mine?" open.
- The Fastify hook (`req.raw` / `reply.raw`) is documented and was verified against Fastify 5.12:
  200 and 503 are recorded with the real status, and modern browser navigations are skipped.

## 0.2.1 — 2026-11-06

- Fix packaging: 0.2.0 shipped with `exports` pointing at `./src/*.ts` — files that are not in
  the tarball — so an installed copy failed to resolve. `npm publish` now runs through
  `publish.mjs`, which stages a manifest whose `main`/`module`/`types`/`exports` point at `dist`.
  0.2.0 is deprecated; use 0.2.1.

## 0.2.0 — 2026-11-05

First public release.

### Crawler probe (`@visdenda/agent-watch`)

- `initVisdenda({ site })` — one required option; a missing token throws at init (wiring error,
  not runtime noise). Every other failure is swallowed: the probe never breaks a page.
- Fire-and-forget `POST /v1/probe` per request with `{ site, ua, path, status?, ip? }`.
- Framework adapters: Next.js middleware (request-only), Cloudflare Worker
  (`wrapWorkerFetch`, rides `ctx.waitUntil`), Hono and Express (response-aware).
- Skips modern browser navigations (`sec-fetch-mode: navigate` **and** `sec-ch-ua`); no crawler
  or browser allow-list ships in the package — server-side matching means new crawlers are
  recognized without a client upgrade.
- First-hop client IP (`cf-connecting-ip` / first `x-forwarded-for` segment) is on by default
  (`sendIp: false` to disable); it is used server-side for ASN aggregation, never stored.

### Markdown negotiation (`@visdenda/agent-watch/markdown`)

- Answers `Accept: text/markdown` with Markdown: q-value negotiation, single internal re-fetch
  with a rewritten `Accept: text/html` (no recursion), non-2xx / non-HTML / over-budget bodies
  fall back to the original HTML.
- Merges `Vary: Accept` (never overwrites), adds an `x-markdown-tokens` estimate, and sets
  `cache-control: no-store` on the Markdown variant.
- `content-signal` is only preserved, never injected: if the origin did not declare one, the
  Markdown response does not add one — the package never speaks for the site owner on training
  or input authorization.
