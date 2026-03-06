# Link Validation MCP Tool — Design

## Problem

Link validation code exists (`src/services/link-validator.ts`) but is never used in production. The old `api-executor.ts` had a `validateOperation()` call that accepted `linkValidationOptions`, but that code path is dead — all execution now goes through the MCP orchestrator. Links written to the site (buttons, text `<a>` tags, image clickthroughs) are never validated.

## Solution

New read-only MCP tool `sq_validate_links` that the supervisor agent calls after execution to catch broken links.

## Tool Spec

**Name**: `sq_validate_links`

**Parameters**:
- `siteId` (string, required) — site identifier (name, alias, or subdomain)
- `pageSlug` (string, required) — page to validate links on

**Behavior**:
1. Resolve site via `findSite()` → get `adminUrl` and `customDomain`
2. Resolve page via `resolvePageIds()`
3. `client.getPageSections(pageSectionsId)` → sections JSON
4. Derive `siteBaseUrl`: prefer `customDomain` (with `https://`), fall back to `https://{subdomain}.squarespace.com`
5. Call `extractAndValidateLinks(sections, { siteBaseUrl })` from existing `link-validator.ts`
6. Return `LinkValidationSummary` JSON

**Returns**: `{ total, ok, broken, redirected, timedOut, skipped, invalidEmails, allPassed, results[] }`

Each result: `{ href, text, status, statusCode?, finalUrl?, error?, durationMs }`

## Orchestrator Changes

1. Add `'mcp__squarespace__sq_validate_links'` to supervisor's `allowedTools` array in `orchestrator.ts`
2. Add a "Link Validation" section to `supervisor.md` prompt instructing the agent to call the tool after verifying operations that involve links

## File Changes

| File | Change |
|------|--------|
| `src/mcp-server/tools/links.ts` | New file — `registerLinkTools(server)` with `sq_validate_links` |
| `src/mcp-server/index.ts` | Import + call `registerLinkTools(server)` |
| `src/orchestrator/orchestrator.ts` | Add tool to supervisor `allowedTools` |
| `src/orchestrator/prompts/supervisor.md` | Add "Link Validation" verification section |
| `src/mcp-server/__tests__/link-tools.test.ts` | New test file — tool registration, success, error cases |

## Existing Code Reused

- `extractAndValidateLinks()` from `src/services/link-validator.ts` — does all the heavy lifting
- `resolvePageIds()` from `src/mcp-server/session.ts` — standard page resolution
- `findSite()` / `getClient()` from `src/mcp-server/session.ts` — site config + client caching
