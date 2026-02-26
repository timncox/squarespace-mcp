# Archived Scripts

These scripts were moved here because they've been superseded by proper service modules, are version-chained (only latest matters), or were one-off debugging/fix tools. Git history is preserved via `git mv`.

## Version Chains (superseded by later versions or by service modules)

| Script | Original Purpose | Superseded By |
|--------|-----------------|---------------|
| `add-projects-direct.ts` | Add 8 projects using direct action calls | add-projects-v2/v3, then content pipeline |
| `add-projects-v2.ts` | Add hero + 8 projects (handles empty page) | add-projects-v3, then content pipeline |
| `add-projects-v3.ts` | Add 8 projects (key findings about addSection) | Content pipeline + template fast path |
| `add-coding-projects.ts` | Phase 1: screenshot + generate content for projects | Content pipeline (research + strategist agents) |
| `add-coding-projects-phase2.ts` | Phase 2: edit Squarespace coding projects page | Content pipeline execution |
| `add-menu-block-section.ts` | Add Menu Formatter project section | Content pipeline |
| `populate-projects.ts` | Populate 8 project sections with content (v1) | populate-v2/v3, then content-save.ts API |
| `populate-v2.ts` | Populate projects (v2: direct Playwright manipulation) | populate-v3, then content-save.ts API |
| `populate-v3.ts` | Populate projects (v3: click text blocks directly) | content-save.ts updateTextBlock() API |
| `cleanup-sections.ts` | Remove blank sections after test runs (v1) | cleanup-v2/v3, then removeBlock API |
| `cleanup-v2.ts` | Remove blank sections (v2: keyboard shortcut) | cleanup-v3 |
| `cleanup-v3.ts` | Remove blank sections (v3: getByRole) | content-save.ts removeBlock() API |
| `cleanup-test-pages.ts` | Delete orphaned test pages (v1) | cleanup-test-pages-v2 |
| `cleanup-test-pages-v2.ts` | Delete orphaned test pages (v2: gear icon flow) | deletePage compound action |
| `cleanup-via-deletepage.ts` | Delete orphaned pages via deletePage action | deletePage compound action (built-in) |
| `test-text-edit.ts` | Test editing a text block (v1) | test-text-edit-v2, then vitest tests |
| `test-text-edit-v2.ts` | Test editing a text block (v2: click directly) | parse-agent-action tests + content-save tests |

## One-Off Debugging/Diagnostic Scripts

| Script | Original Purpose | Superseded By |
|--------|-----------------|---------------|
| `debug-add-section.ts` | Debug ADD SECTION button click failures | addSection compound action (working) |
| `debug-delete-button.ts` | Debug Delete button in page settings | deletePage compound action (working) |
| `delete-test-section.ts` | Delete specific section by hardcoded ID | removeBlock API + browser agent |
| `diagnose-after-page-click.ts` | Investigate what happens after Add Blank > Page | createPage compound action (working) |
| `diagnose-block-picker.ts` | Find Image tile in block picker DOM | addImageBlock/addBlockToSection (working) |
| `diagnose-create-page.ts` | Investigate Create Page UI flow | createPage compound action (working) |
| `diagnose-empty-page.ts` | Find ADD SECTION on empty page | addSection handles empty pages |
| `diagnose-image-flow.ts` | Debug image upload flow | addImageBlock compound action (working) |
| `diagnose-image-iframe.ts` | Confirm block picker is inside iframe | addImageBlock compound action (working) |
| `diagnose-image-upload.ts` | Debug 2nd addImageBlock failure | addImageBlock re-entry fix (applied) |
| `diagnose-inline-title.ts` | Debug inline title editing after page create | createPage compound action (working) |
| `diagnose-remove.ts` | Debug getByRole for remove button | removeBlock API fast path |
| `diagnose-second-image.ts` | Debug 2nd image add failure | addImageBlock re-entry fix (applied) |
| `inspect-coding-projects.ts` | Quick inspect of coding projects page | fetchPageStructure() API |
| `inspect-coding-projects-detail.ts` | Detailed inspect of coding projects blocks | fetchPageStructure() + summarizePageSections() |
| `inspect-sections.ts` | Inspect sections on coding projects | fetchPageStructure() + summarizePageSections() |
| `test-bbox.ts` | Debug boundingBox before/after scroll | Handler utils (working) |
| `test-btn-inspect.ts` | Inspect ADD BLOCK elements in DOM | addBlockToSection (working) |
| `test-find-buttons.ts` | Find ADD BLOCK/EDIT SECTION elements | enterSectionEditMode (working) |
| `test-sections.ts` | List .page-section elements in iframe | fetchPageStructure() API |

## One-Off Fix Scripts

| Script | Original Purpose | Superseded By |
|--------|-----------------|---------------|
| `fix-footer-cleanup.ts` | Remove accidental content from footer section | Footer API (getFooterSections, updateFooterTextBlock) |
| `fix-footer.ts` | Remove "BIG IDEAS" text from footer | Footer API (updateFooterTextBlock, patchFooterTextBlock) |
| `fix-menu-formatter-url.ts` | Fix button URL in specific section by ID | editButtonBlock + updateButtonBlock API |
| `set-button-urls.ts` | Set URLs for 8 project buttons by section ID | editButtonBlock + updateButtonBlock API |
| `upload-pooltogether-image.ts` | Fix missing image in PoolTogether section | replaceImage + updateImageBlock API |
| `capture-projects.ts` | Screenshot Tim's coding project sites | One-off (content already captured) |

## Test Scripts (superseded by vitest)

| Script | Original Purpose | Superseded By |
|--------|-----------------|---------------|
| `test-add-block.ts` | Quick test of addTextBlock API | `content-save-add-block.test.ts` (13+ tests) |
| `test-add-section.ts` | Test addSection + enterSectionEditMode | `compound-actions.integration.test.ts` |
| `test-button-flow.ts` | Test button creation + URL editing flow | `compound-actions.integration.test.ts` |
| `test-button-url.ts` | Test button URL editing automation | `compound-actions.integration.test.ts` |
| `test-content-typing.ts` | Test typing content into Text/Button blocks | `compound-actions.integration.test.ts` |
| `test-image-block.ts` | Test addImageBlock compound action | `compound-actions.integration.test.ts` |
| `test-image-flow.ts` | Test image block + upload flow | `compound-actions.integration.test.ts` |
| `test-image-upload.ts` | E2E image upload test | `compound-actions.integration.test.ts` |
| `test-section-deletion.ts` | Test section deletion automation | `compound-actions.integration.test.ts` |
| `test-section-flow.ts` | Test section create + delete flow | `compound-actions.integration.test.ts` |
| `e2e-create-delete-test.ts` | E2E create + delete page test | `compound-actions.integration.test.ts` |
