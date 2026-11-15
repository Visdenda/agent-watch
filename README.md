# @visdenda/agent-watch

Zero-dependency helpers that make a site readable by AI agents:

- **Crawler probe** — record which AI crawlers fetch your pages, with path and response status.
- **Markdown negotiation** (`./markdown`) — answer `Accept: text/markdown` with Markdown while
  browsers keep getting HTML.

```bash
npm install @visdenda/agent-watch
```

### Entry points

The package has no framework dependency; each subpath is a request shape. Import only the one you
need, so a Worker never pulls in the Node adapter and vice versa:

| Entry                            | Exports                          | Use when                                                             |
| -------------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| `@visdenda/agent-watch`          | `createAgentWatch` + types/tools | You want one instance and call `watch.probe()` / `watch.wrapFetch()` |
| `@visdenda/agent-watch/workers`  | `wrapFetch`                      | Cloudflare Workers, Bun, Deno, Vercel/Netlify Edge                   |
| `@visdenda/agent-watch/node`     | `nodeMiddleware`                 | Express, Koa, Polka, NestJS, Fastify (`req.raw`)                     |
| `@visdenda/agent-watch/hono`     | `contextMiddleware`              | Hono (any `context + next()` signature)                              |
| `@visdenda/agent-watch/next`     | `requestMiddleware`              | Next.js middleware and other request-only hooks                      |
| `@visdenda/agent-watch/markdown` | `markdownNegotiation`            | Markdown negotiation                                                 |

Every adapter takes `{ token }` — the `vdc_...` site token, not a site id or domain. The wire field
stays `site` (frozen by protocol v2); only the configuration key is named after what it actually is.

## Crawler probe

AI crawlers do not run JavaScript, so page tags never see them. The probe runs on the server,
where the request actually arrives. Send one `POST /v1/probe` per request, fire-and-forget:
network failures, timeouts and non-2xx responses are swallowed — the probe never breaks a page.

Get the site token from **Search → Sessions → Traffic**. The token is a routing key,
not a secret: it is visible in your source. The probe endpoint cannot check Origin (server-side
callers do not send one), so the real limit is the daily cap — 2,000 probe events and 500 distinct
paths on the free plan, 20,000 and 5,000 on paid. Caps are visible: the dashboard states when a
window is a lower bound and how many path hits went to the overflow bucket. Forged reports can
only pollute your own dashboard. Rotate the token to stop them.

A domain in the payload would not work: anyone could post hits for any site, and there would be
no way to revoke a sender. A per-site token is the smallest thing that answers _which site these
hits belong to_, is write-only, and can be rotated. The page beacon and the probe share one token,
so one rotation covers both channels.

### How crawler identity is verified

A user agent is a claim, not proof. The collector verifies every hit server-side against the
vendor's own published data:

- **Published IP ranges.** OpenAI, Anthropic, Perplexity, Google, Bing, DuckDuckGo and others
  publish JSON range lists. A hit inside the range is `verified`; a hit outside is `unverified`
  only when the vendor's complete list loaded (any failed file downgrades the conclusion to
  `not-checked`).
- **Reverse DNS, forward-confirmed.** For Google, Bing, Apple, Meta and DuckDuckGo the PTR name
  must end in the vendor suffix **and** resolve back to the same IP. A PTR that does not resolve
  back is `unverified`; DNS/network failures are `not-checked`, never `unverified`.
- **Worst verdict wins for the day.** One unverified hit stops that agent being reported as
  verified for the rest of the day. The console shows `verified`, `unverified` and `not-checked`
  as separate states.

The package sends the IP and the user agent; all matching happens on the server, so new crawlers
and new ranges do not need a client upgrade.

### The crawler list is data, not part of this package

The agents the collector recognizes are published separately as
[`@visdenda/ai-crawler-directory`](https://www.npmjs.com/package/@visdenda/ai-crawler-directory)
([browsable](https://visdenda.com/crawlers), [JSON](https://visdenda.com/crawlers.json),
[CSV](https://visdenda.com/crawlers.csv), CC BY 4.0). It is a separate package on purpose: this
SDK stays zero-dependency, the list can change without an SDK release, and the dataset is citable
on its own. The probe does not need it installed — matching runs server-side.

### Three request shapes, not one adapter per framework

Every backend in the JS ecosystem hands you one of three things: a fetch handler, a Node
`(req, res, next)` pair, or its own middleware hook. One helper covers each, so there is no
`-fastify`, `-koa` or `-nuxt` package to keep in sync.

Names are runtime shapes, not frameworks: the package has no framework or brand dependency, and
non-JS backends use the HTTP contract directly.

| You get                                        | Where                                                                             | Import path | Helper                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ----------- | --------------------------------------- |
| A fetch handler (`request` in, `Response` out) | Cloudflare Workers, Bun, Deno, Vercel/Netlify functions                           | `/workers`  | `wrapFetch`                             |
| A Node request/response pair                   | Express, Koa, Polka, NestJS (default platform), Fastify via `req.raw`/`reply.raw` | `/node`     | `nodeMiddleware`                        |
| A context + `next()` middleware                | Hono                                                                              | `/hono`     | `contextMiddleware`                     |
| A request-only hook                            | Next.js, Astro, SvelteKit, Nuxt                                                   | `/next`     | `requestMiddleware`, or a 6-line recipe |

A framework hook is a recipe rather than a package: Astro's `defineMiddleware` and SvelteKit's
`handle` both await a `Response`, so the status comes for free; Nuxt's `defineEventHandler` does
not, so it reports without one (same class as Next middleware). A recipe stays shorter than the
adapter would be — which is the whole test for whether one gets written.

Anything else — Go, Rust, PHP, Python, Ruby, Java, a home-grown HTTP layer — speaks the protocol
directly; see **Any other stack** below.

### Probe v2 options

The defaults need no configuration. These options change what the probe can see — or how a
failure surfaces:

- `trustProxy: true` — only when the site really sits behind a reverse proxy. By default
  `cf-connecting-ip` is trusted and the proxy chain is ignored, because any client can send those
  headers and poison the ASN rollup. With it on, the probe falls back from `x-forwarded-for` to
  `x-real-ip` (nginx), `true-client-ip` and `fly-client-ip`.
- `batch: { maxEvents: 20, flushMs: 5000 }` — off by default. A buffer is lost when the isolate is
  recycled, so batching is a cost optimisation, not correctness. Under Workers the SDK keeps the
  invocation alive through `waitUntil` when one is available; in a long-running Node process the
  timer is reliable. Values are clamped to the server contract (`maxEvents` ≤ 50, `flushMs` ≤
  10 s) and a flush is split into ≤ 32 KB batches, so a long referrer can never turn the whole
  batch into a single rejected request.
- `country` / `colo` — fallbacks for runtimes without a platform header. Country is read from
  `cf-ipcountry`, `x-vercel-ip-country` or Netlify's `x-nf-geo`; `colo` comes from `cf-ray`.
  `colo` is the edge node, not the visitor's country.
- `skipBrowserNavigations: false` — report human navigations too. Document navigations
  (`sec-fetch-mode: navigate` + `sec-fetch-dest: document` + an HTML `accept`) are skipped by
  default on every engine — Firefox and Safari do not send Chromium client hints — while clicks
  from AI answers are reported when the referrer is a known AI host (`chatgpt.com`,
  `perplexity.ai`, `claude.ai`, …).
- `sendIp: false` — stop reporting the client IP. It is on by default because ASN evidence needs it.
- `onError` / `debug: true` — failures are silent by default. `onError({ path, status?, error?,
  events? })` receives non-2xx responses and network/timeout errors; `debug: true` warns once and
  points at `watch.check()`. `onError` wins when both are set, and a throwing callback is ignored.

Every report carries `v: 2` (the protocol version, not the package version), `ref` (referrer URL,
host only is stored), `utm` (fallback), `neg` (html/markdown), `dur` (handler time), `country`,
`colo` and the `x-agent-watch` version header. A payload without `v` is accepted as protocol 1.
Machine files (`/robots.txt`, `/llms.txt`, sitemaps, `.md`) are counted separately from page
crawls. `/v1/probe/batch` accepts 1–50 events (≤ 32 KB) and `POST /v1/probe/check` verifies a
token without leaking site details — call `watch.check()` to run it from your own process instead
of hand-writing a curl.

#### Fetch API

```ts
import { wrapFetch } from "@visdenda/agent-watch/workers";

// Workers, Bun, Deno, Vercel Edge, Netlify Edge
export default {
  fetch: wrapFetch({ token: "vdc_your_token" }, (request, env, ctx) => env.ASSETS.fetch(request)),
};
```

Response-aware: the real status is reported after the handler returns. When the third argument
carries `waitUntil` (Workers, Next Edge), the POST rides it so it never delays the response or
gets cut off when the instance ends; without it (Bun, Deno) the probe is a plain fire-and-forget
request.

**Hono** runs on every one of those runtimes but has its own middleware signature:

```ts
import { Hono } from "hono";
import { contextMiddleware } from "@visdenda/agent-watch/hono";

const app = new Hono();
app.use("*", contextMiddleware({ token: "vdc_your_token" }));
```

It reports after `await next()` with the real status, and reuses `executionCtx.waitUntil` when the
runtime provides one.

#### Node `(req, res, next)`

```ts
import express from "express";
import { nodeMiddleware } from "@visdenda/agent-watch/node";

const app = express();
app.use(nodeMiddleware({ token: "vdc_your_token" }));
```

Response-aware: reports on the response's `finish` event, so a 500 is not recorded as a 200.
The same middleware covers Koa (through `koa-connect`) and NestJS on its default Express platform
(`app.use(...)` on the underlying instance).

**Fastify** has its own lifecycle, but `req.raw` / `reply.raw` are plain Node objects, so one hook
is enough:

```ts
import { nodeMiddleware } from "@visdenda/agent-watch/node";

const probe = nodeMiddleware({ token: "vdc_your_token" });
fastify.addHook("onRequest", (request, reply, done) => {
  probe(request.raw, reply.raw, done);
});
```

#### Framework hooks (Astro, SvelteKit, Nuxt)

Astro and SvelteKit run your code in their own hook, and both hand you a `Response`, so the real
status is yours:

```ts
// Astro — src/middleware.ts
import { defineMiddleware } from "astro:middleware";
import { createAgentWatch } from "@visdenda/agent-watch";

const watch = createAgentWatch({ token: "vdc_your_token" });

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();
  watch.probe({
    ua: context.request.headers.get("user-agent"),
    path: new URL(context.request.url).pathname,
    status: response.status,
    ip: context.clientAddress,
  });
  return response;
});
```

```ts
// SvelteKit — src/hooks.server.ts
import { createAgentWatch } from "@visdenda/agent-watch";

const watch = createAgentWatch({ token: "vdc_your_token" });

export const handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  watch.probe({
    ua: event.request.headers.get("user-agent"),
    path: event.url.pathname,
    status: response.status,
    ip: event.getClientAddress(),
  });
  return response;
};
```

Nuxt is the exception: `defineEventHandler` in `server/middleware/` sees the request but not the
response, so report without `status` — same class as Next middleware below. SolidStart's
`createMiddleware` takes H3 middleware and does await a `Response`, so it behaves like Astro.

#### Next.js middleware

```ts
// middleware.ts
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { requestMiddleware } from "@visdenda/agent-watch/next";

const probe = requestMiddleware({ token: "vdc_your_token" });

export function middleware(request: NextRequest, event: NextFetchEvent) {
  // 第二个参数可选：申请把上报挂到 event.waitUntil，响应返回后不会被截断。
  probe(request, (task) => event.waitUntil(task));
  return NextResponse.next();
}
```

Request-only: the response does not exist yet, so these hits show `no-status-source`. Middleware
on Vercel, Netlify or a self-hosted Node server is still server-side.

#### Any other stack

The protocol is HTTP + JSON; no SDK is needed.

```bash
curl -X POST https://visdenda.com/v1/probe \
  -H 'content-type: application/json' \
  -d '{"site":"vdc_your_token","ua":"GPTBot/1.2","path":"/pricing","status":200,"ip":"203.0.113.7"}'
```

`status` and `ip` are optional. Only known crawler user agents are stored; everything else is
dropped server-side.

PHP has no SDK — the endpoint is the integration. This runs after the response, so the visitor
never waits for the report:

```php
<?php
// PHP-FPM, Laravel, Symfony, WordPress: one fire-and-forget POST per request.
$watch = static function (?int $status): void {
    $payload = [
        'site' => 'vdc_your_token',
        'ua'   => $_SERVER['HTTP_USER_AGENT'] ?? '',
        'path' => parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/',
    ];
    if ($status !== null) $payload['status'] = $status;
    if (!empty($_SERVER['HTTP_REFERER'])) $payload['ref'] = $_SERVER['HTTP_REFERER'];
    if (!empty($_SERVER['REMOTE_ADDR'])) $payload['ip'] = $_SERVER['REMOTE_ADDR'];

    $context = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "content-type: application/json\r\n",
        'content'       => json_encode($payload),
        'timeout'       => 1,
        'ignore_errors' => true,
    ]]);
    @file_get_contents('https://visdenda.com/v1/probe', false, $context);
};

// PHP-FPM: finish the response first, then report.
register_shutdown_function(static function () use ($watch): void {
    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    $watch(http_response_code() ?: 200);
});
```

Behind a CDN, `REMOTE_ADDR` is the CDN edge. Pass the real client IP from the header your CDN sets
(`CF-Connecting-IP`, `X-Forwarded-For`, …) instead. On a long-running PHP server (Swoole, RoadRunner)
prefer a queued job over `register_shutdown_function`.

## What each setup can see

| Setup                                                                                            | AI crawler hits                                                                     | Human traffic + vitals         |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------ |
| Server probe (Next middleware, Worker, Hono, Express, own HTTP call)                             | Yes — agent, path, status, ASN checks (ASN needs an edge IP header or `trustProxy`) | No (pair with the page script) |
| Page script only (tag manager, CMS embed)                                                        | No — bots never execute JavaScript; the block stays `na`                            | Yes                            |
| Hosted platform with no server hooks (Webflow, Wix, Squarespace, Shopify, Ghost, Framer, Bubble) | No server hook, so no probe                                                         | Page script only               |

Never describe a script-only install as "you can see AI crawlers". The honest answer is a
server-side probe; the console shows `na` with a pointer to this page until one is installed.

A CDN that answers from cache never reaches origin middleware. Two ways out: run the probe at the
edge, where it runs before the cache (a Cloudflare Worker route, Vercel/Netlify edge middleware),
or ship CDN/access logs to the ingestion API once it ships. Nothing on the origin can see a
cache hit, so "installed the Node middleware and still see nothing" is usually a caching answer,
not a crawler answer.

## Probe rules

- `site` is the only required option. Missing it throws at init — that is a wiring error, not
  runtime noise. Every other failure is silent by default (`onError` / `debug` make it visible).
- `endpoint` defaults to `https://visdenda.com`; `sendIp` and `skipBrowserNavigations` default to
  `true`; `timeoutMs` defaults to 2000; `trustProxy` defaults to `false`; batching is off.
- `/v1/probe`, `/v1/probe/batch` and `/v1/probe/check` are never reported. If the collector shares
  an origin with your app (self-hosting it, or proxying those paths back to the same server), the
  probe's own POST would otherwise re-enter the wrapped handler, be reported again, and recurse
  until the subrequest limit. A collector mounted at a different path still needs excluding in the
  caller.
- Document navigations (`sec-fetch-mode: navigate` **and** `sec-fetch-dest: document` **and** an
  HTML `accept`) are skipped unless the referrer is a known AI host. This works on Firefox and
  Safari too: requiring `sec-ch-ua` would only skip Chromium and let other browsers' page views
  consume the crawler budget. No crawler or browser allow-list is involved.
- Empty user agents are dropped; user agents and paths over 512 characters are truncated, not
  dropped. An IP longer than 45 characters is dropped: the server schema rejects the whole event
  otherwise, and the failure is silent.
- `watch.check()` posts to `/v1/probe/check` and reports `{ valid: true }`, `{ valid: false,
  reason: "invalid" }` (bad token / unverified site) or `{ valid: false, reason: "unreachable" }`
  (network or collector error). `watch.verify()` is the boolean form
  (`(await check()).valid`) for a startup gate. Use one of them once after wiring: a typo
  otherwise surfaces as "installed, no error, zero data".
- No UA list ships in the package. Server-side matching means new crawlers are recognized without
  a client upgrade.
- No retries and no offline queue: a probe hit is a disposable signal, not billing data. Batching
  is opt-in and drops a failed batch instead of retrying it.
- The package ships ESM and CJS builds. Loading both in one process creates two SDK instances with
  two independent batch buffers — keep one module system per process.

## Markdown for agents

```ts
import { markdownNegotiation } from "@visdenda/agent-watch/markdown";

// Workers, Bun, Deno, edge runtimes
export default markdownNegotiation().wrapFetch((req, env) => env.ASSETS.fetch(req));

// Fetch-style middleware
const handler = markdownNegotiation({ markdownPaths: ["/", "/docs", "/pricing"] });
const response = await handler(request, (req) => fetch(req));
```

The middleware answers `Accept: text/markdown` with Markdown, merges `Vary: Accept`, adds an
`x-markdown-tokens` estimate, preserves an existing `content-signal` header, and falls back to
the original HTML on any failure. Browsers never see Markdown.

On runtimes with `caches` (Workers), pass `cache: { ttlMs: 300000 }` to reuse the converted
response for five minutes. Only 200 responses are stored, and only when the origin did not mark
the response as personalized (`set-cookie`, `cache-control: private|no-store`, `vary: cookie`).
The stored copy keeps `Vary: Accept` and uses `cache-control: max-age=<ttl>, private`: the TTL is
what the Cache API needs, and the two headers together stop an upstream CDN from storing the
Markdown variant under the bare URL and serving it to browsers. The response served to the client
is otherwise unchanged.

If you combine the Markdown middleware with the crawler probe, wrap the probe **outside** the
Markdown middleware (`probe(wrapFetch(markdown(handler)))`). The probe needs to see the final
`text/markdown` response to report `neg: "markdown"`; inside, it only ever sees HTML.

### Five pitfalls this package handles

1. **q-values** — `text/html;q=0.9` must beat `text/markdown;q=0.5`; equal q means Markdown.
2. **Vary must be merged, not set** — otherwise a CDN caches the Markdown variant and serves it
   to browsers.
3. **The internal re-fetch must rewrite `Accept`** to `text/html`, or the request recurses.
4. **Non-2xx / non-HTML / bodies over the budget must fall back** to the original response —
   conversion is an optimisation, never a failure mode.
5. **`content-signal` is preserved** exactly as the origin sent it; we never interpret it.

Options: `markdownPaths` (default: every page), `excludePatterns` (default: `/api`, `/_next`,
`/cdn-cgi`, static extensions), `budgetBytes` (2 MB), `timeoutMs` (2 s).

Detection is vendored in the product's audit: a `text/markdown` response **without**
`Vary: Accept` is a failure, because that is the configuration that poisons caches.

## Source

This repository is the public source mirror of `@visdenda/agent-watch`. Development happens in a
private monorepo; fixes are ported here before a release, and npm publishes from this repository
with provenance. Issues are welcome here.
