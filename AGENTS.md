# AGENTS.md

## Commands
- `npm start` — runs `src/server.js` on port **4141** (not 3000). No build step, dev server, or bundler.
- No `test` script and no test files exist (README's `npm test` is stale). If adding tests: Node built-in runner, `*.test.js`, `node --test`.
- No lint / typecheck / formatter configured — don't add tooling unless asked.

## Architecture
- `src/server.js` (Express + SSE), `src/debate.js` (pure state machine; all I/O via injected `generate`), `src/llm.js` (sole gateway for provider calls). Frontend is one vanilla-JS file inline in `public/index.html`.
- Zero dependencies beyond express — keep it that way (no frameworks, no bundler, no codegen).
- API keys are never stored server-side: the client keeps accounts in `localStorage` and sends keys with each `/api/debate` request. Server caches only `provider:model → {id, context}` to stabilize turn order.
- `src/debate.js` must stay pure and resumable (serializable `state`); `turn` counts individual LLM calls, `round = ceil(turn / 2)`; consensus needs ≥2 agree AND max position ≤ threshold; tiebreaker is position.
- `agreement` is a REQUIRED output field: the server enforces it in the system prompt and defaults it to `false` on parse failure — never treat it as optional.
- Client/server SSE contract: `turn`, `wait`, `paused`, `done`, `error` events as `data: {json}\n\n`.
- Cost = USD per 1M tokens; `totals.tokens` counts prompt + completion; budgets can stop the debate mid-round.

## i18n rules (most common bug source)
- Every user-visible string must exist in ALL 4 locale files (`locales/{es,en,fr,pt}.json`) under the same key. Frontend resolves `data-i18n`/`data-i18n-attr` and `t('key', params)`.
- Server error codes are i18n keys: `throw { status, error: 'code' }` → UI looks up `error.<code>`. New error codes must be added to all 4 files or the UI shows the raw key.
- `es.json` is the reference; keep key sets identical across the 4 files.

## Adding a provider
1. `src/llm.js`: add to `SUPPORTED` + `resolveBaseUrl` (per-provider base URL).
2. `src/server.js`: add its label in the `/api/providers` response.
3. No frontend change needed (providers are fetched dynamically).

## Conventions
- README is the engine-semantics spec; on conflict, `src/debate.js` wins.
- Match the existing compact, single-purpose module style.
