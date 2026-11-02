# Codex Review Notes

No code changes were made. These are the main things I would change after reviewing the repository.

## 1. Fix MCP instruction and prompt drift

The MCP handshake instructions and prompt text mention tool names that are not actually registered. This is a runtime behavior problem for agents, not just a documentation issue.

- `sq_add_text_block` is referenced in the server guidance, but the real tool is `sq_add_text`
- `sq_save_code_injection` is referenced in the server guidance, but the real tool is `sq_update_code_injection`

Relevant files:

- `src/mcp-server/index.ts:187`
- `src/mcp-server/index.ts:239`
- `src/mcp-server/index.ts:271`
- `src/mcp-server/tools/text.ts:323`
- `src/mcp-server/tools/site.ts:267`

## 2. Rework site discovery caching

`fetchAccountSites()` marks discovery as already fetched before the async fetch succeeds. That means one transient failure, or calling `sq_list_sites` before login/session setup, can permanently suppress discovery for the lifetime of the process.

I would replace the boolean with an in-flight promise and only treat discovery as fresh after a successful fetch.

Relevant files:

- `src/mcp-server/session.ts:102`
- `src/mcp-server/session.ts:123`

## 3. Harden geocoding

The map tools depend on Nominatim through an unbounded `fetch()` with no timeout, no caching, and no fallback path for callers who already know the coordinates.

That creates unnecessary latency and reliability risk for `sq_add_map` and `sq_update_map`, and it increases the chance of rate-limit issues on repeated addresses.

I would add:

- a timeout
- a small cache
- an explicit `lat/lng` input path for callers that already have coordinates

Relevant files:

- `src/services/geocoding.ts:11`
- `src/mcp-server/tools/blocks.ts:1244`
- `src/mcp-server/tools/blocks.ts:1295`

## 4. Limit concurrency for batch blog updates

`sq_update_blog_posts` uses `Promise.allSettled` over the full batch. That is fine for small batches, but it will create avoidable load and rate-limit risk for larger updates.

I would run these through a concurrency limiter instead of firing all requests at once.

Relevant files:

- `src/mcp-server/tools/content.ts:138`
- `src/mcp-server/tools/content.ts:157`

## 5. Factor the MCP tool wrapper pattern

The tool registration layer repeats the same `try/catch`, error formatting, and JSON serialization logic across many handlers. That repetition increases the chance of drift in behavior and makes small changes expensive.

I would introduce a small helper for:

- consistent error shaping
- standard JSON responses
- less boilerplate in `registerTool()` handlers

Relevant files:

- `src/mcp-server/tools/content.ts:28`
- `src/mcp-server/tools/site.ts:29`
- `src/mcp-server/tools/blocks.ts:43`

## 6. Simplify the content-save module surface

The `content-save` area relies on a very large duplicated type export/import list and side-effect-based prototype augmentation. It works, but it makes the module harder to navigate and refactor than necessary.

I would move toward more explicit exports or normal class methods instead of wiring functionality through augmentation side effects.

Relevant files:

- `src/services/content-save/client.ts:26`
- `src/services/content-save/index.ts:1`
