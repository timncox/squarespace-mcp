# Planning

## Crash Hardening (Lower Priority)

- [ ] Monitor SSE listener count — `dashboardEvents` EventEmitter may hit Node's default 10-listener warning as concurrent dashboard tabs increase. Add `dashboardEvents.setMaxListeners(50)` or track listener counts.
- [ ] Add error handling around `recoverOrphanedExecutions()` DB call in server startup — a DB init failure currently propagates uncaught during startup
- [ ] Audit other async callbacks registered at module load time (e.g., `onNewEmail`, `onNewWhatsAppMessage`) for missing `.catch()` or try/catch wrappers

## Remaining TODO

- [x] Fix `patchFooterTextBlock` for embedded footer sections — fails with "pageSectionsId not available" when `footer.sections` is inline; must use `getHeaderFooter()` → modify → `saveHeaderFooter()` pattern directly


- [x] Thread `siteBaseUrl` through `execution.ts` `validateOperation()` calls to enable link validation in production
- [x] Validate speculative endpoints against live site — confirmed via `storage/recordings/api-traffic-1772151622718.json`
  - `getSectionCatalog` ✅ GET `/api/section-catalog/sections?engine=FLUID` → 200
  - `copyTemplateSection` ✅ POST `/api/content/copy/section?sourceWebsiteId=...` with body `[]` → 200
  - `addBlankSection` ❌ BROKEN — current implementation calls `catalog-preview/blankFluidEngineSection` expecting JSON but it returns HTML; fix: remove GET step, use `generateBlockId()` for sectionId, POST with no body
  - `copyTemplateSection` ⚠️ MINOR BUG — body is `''` but should be `JSON.stringify([])`
  - `saveCustomCSS` ⏳ still unverified — CSS save not triggered in recording session
  - Quote/code block JSON structure ⏳ still unverified — blocks not added in recording session
- [x] Fix `addBlankSection` in `src/services/content-save.ts` — remove HTML GET step, generate sectionId via `generateBlockId()`, POST with no body
- [x] Fix `copyTemplateSection` body — change `body: ''` to `body: JSON.stringify([])`
- [x] Run another recording session to capture: CSS save (`Design → Custom CSS → Cmd+S`), quote block add, code block add
  - CSS save: `POST /api/template/SetTemplateCustomCss` (confirmed Feb 28 2026)
- [x] Run `scripts/discover-block-types.ts` to capture JSON structures for all block types on a live site
  - Quote = **type 31** (was suspected 44), value: `{ quote, source, blockAnimation, vSize, hSize, schemaName, aspectRatio, floatDir }`
  - Code HTML = **type 1337** (same as Image), distinguished by `value.wysiwyg.engine === 'code'`, value: `{ wysiwyg: { engine, mode, isSource, source }, html }`
  - Both constants and API methods updated in content-save.ts; all tests pass
- [ ] Add `SQUARESPACE_API_KEY` to `.env` for Commerce API access

## API-First Priority (Playwright as Last Resort)

### 1. Wire missing API fast paths in action handlers

These ContentSaveClient methods exist but are not wired as fast paths in the action handlers:

- [x] `editButtonBlock` in `src/automation/actions/text-editing-handlers.ts` → call `updateButtonBlock()` first, fall back to UI
- [x] `editQuoteBlock` in `src/automation/actions/text-editing-handlers.ts` → call `updateQuoteBlock()` first, fall back to UI
- [x] `editCodeBlock` in `src/automation/actions/text-editing-handlers.ts` → call `updateCodeBlock()` first, fall back to UI
- [x] `formatTextBlock` → API fast path via `tryFormatTextBlockApi()` handles heading1–4, bold, italic, alignment; falls back to UI for paragraph variants, monospace, fontSize

### 2. Create agent skill file documenting API capabilities

No skill files exist yet (planned but never built). Agents make decisions without knowing what the API can do.

- [ ] Create a skill/knowledge reference file (e.g., `.claude/skills/squarespace-api.md`) listing all ContentSaveClient methods, block types, and when to use API vs Playwright
- [ ] Inject this into the content strategist prompt so it knows the full API surface when generating plans
- [ ] Ensure the content strategist knows about all API-addable block types: text, button, image, divider, video, quote, code, menu, gallery

### 3. Update browser agent prompt to prefer API

- [x] Add an explicit principle to `src/automation/browser-agent-prompt.ts`: "Always try the Content Save API before UI automation. API calls are faster and more reliable."
- [x] List which actions have API fast paths so the agent knows when to expect API calls to be attempted

### 4. Audit API executor routing

- [x] Review `classifyPlanForApi()` in `src/services/conversation/execution.ts` — ensure it routes as aggressively as possible to API executor
- [x] Check that all `blank_api` block types (text, button, image, gallery, divider, video, quote, code) are handled in `executeBlankApiOperation()`
- [x] Verify `executeContentPlanViaApi()` covers all operation types that ContentSaveClient supports
