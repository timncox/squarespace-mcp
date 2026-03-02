# Squarespace API Discovery — Full Sweep Findings

**Date**: 2026-03-02
**Test site**: grey-yellow-hbxc (Smyth Tavern)

## Confirmed NEW Endpoints

### 1. Settings Write — `PUT /api/settings` (200)

**Source**: `discover-settings-write.ts`

Full read-modify-write pattern: GET `/api/settings` → modify fields → `PUT /api/settings` with full JSON body.

**Request body**: Full settings JSON (~63 fields). Same shape returned by `getSettings()`.

**Also confirmed**: `PUT /api/rest/websites/mine` → 200 (website-level settings, different scope).

**Dead ends**: `PATCH /api/settings` → 405, all `POST /api/config/Save*` → 404.

### 2. Navigation Reorder — `POST /api/widget/UpdateNavigation` (200)

**Source**: `discover-nav-reorder.ts`

**Request body**:
```json
{
  "fieldName": "mainNav",
  "templateId": "5c5a519771c10ba3470d8101",
  "navigation": {
    "items": [
      { "id": "pageId1", "type": "page", ... },
      { "id": "pageId2", "type": "page", ... }
    ]
  }
}
```

Captured after drag-and-drop reorder in Pages panel. Also triggers `GET /api/commondata/GetSiteLayout` after update.

**Dead ends**: `PUT /api/navigation` → 405, `POST /api/navigation` → 405, all `/api/config/SaveNavigation*` → 404.

### 3. Advanced Settings Read — `GET /api/config/GetAdvancedSettings` (200)

**Source**: `discover-url-redirects.ts`

New read-only endpoint for advanced settings (URL mappings, 404 page, etc.).

### 4. Blog Post Creation — `POST /api/content/blogs/{collectionId}/text-posts` (200)

**Source**: `verify-dead-ends.ts` (blog-scheduling action)

**Request body**:
```json
{
  "addedOn": 1772426294144,
  "publishOn": 1772426294144,
  "websiteId": "69934978b23b0453e46b6508",
  "workflowState": 4,
  "body": { "raw": false, "layout": { "columns": 12, "rows": [] } },
  ...
}
```

This is the create endpoint — we already have `createBlogPost()` in content-save.ts but this confirms the exact format.

### 5. Design Settings READ Endpoints

**Source**: `discover-design-settings.ts`

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /api/website-fonts` | 200 | Current font configuration |
| `GET /api/website-colors` | 200 | Current color palette |
| `GET /api/website-colors/definitions` | 200 | Available color definition structure |
| `GET /api/website-colors/defaults` | 200 | Default color values |
| `GET /api/website-fonts/font-definitions` | 200 | Available font definitions |
| `GET /api/template/GetTemplateTweakSettings?version=3` | 200 | Template tweak settings |
| `GET /api/tweak-engine` | 200 | Tweak engine configuration |

**Design settings WRITE**: NOT discovered. The save button stayed disabled (couldn't trigger a font/color change programmatically in headless). Needs non-headless investigation.

### 6. Website-Level Settings — `PUT /api/rest/websites/mine` (200)

**Source**: `discover-settings-write.ts`

Different scope from `/api/settings`. Likely handles account-level website config vs site-level settings.

## Areas That Need Non-Headless Debugging

| Area | Issue | Script |
|------|-------|--------|
| Design settings (fonts) | Save button stayed disabled — couldn't select a different font | `discover-design-settings.ts` |
| Design settings (colors) | Couldn't find color swatches/hex inputs | `discover-design-settings.ts` |
| Social links | "Add" button click intercepted by overlay (`css-xnq07z`) | `verify-dead-ends.ts` |
| Announcement bar | Toggle click intercepted by overlay (`css-16kwtx0`) | `verify-dead-ends.ts` |
| Popups | Toggle click intercepted by overlay (`css-1s7n2of`) | `verify-dead-ends.ts` |
| URL redirects | Textarea not clickable in headless mode | `discover-url-redirects.ts` |
| Form creation | "Edit Content" button not found | `discover-form-creation.ts` |

## Confirmed Dead Ends

| Pattern | Status | Notes |
|---------|--------|-------|
| `POST /api/config/SaveSettings` | 404 | Not a valid endpoint |
| `POST /api/config/SaveBusinessInformation` | 404 | Not a valid endpoint |
| `POST /api/config/SaveNavigation` | 404 | Not a valid endpoint |
| `POST /api/config/SaveSocialLinks` | 404 | Not a valid endpoint |
| `POST /api/config/SaveAnnouncementBar` | 404 | Not a valid endpoint |
| `POST /api/config/SaveUrlMappings` | 404 | Not a valid endpoint |
| `PATCH /api/settings` | 405 | Method not allowed |
| `PUT /api/navigation` | 405 | Method not allowed |
| `POST /api/navigation` | 405 | Method not allowed |

**Pattern**: Squarespace does NOT use the `POST /api/config/Save{Thing}` pattern except for `SaveInjectionSettings` and `SaveTemplateCustomCss`. Most writes use `PUT` on the resource endpoint or specialized `POST` endpoints like `UpdateNavigation`.

## URL Mappings

URL mappings are likely part of the full settings JSON at `PUT /api/settings`. The `GET /api/config/GetAdvancedSettings` endpoint returns settings that include URL mapping configuration. The write pattern would be: read settings → modify `urlMappings` field → PUT back.

## Implementation Priority

1. **`saveSettings()`** — `PUT /api/settings` with read-modify-write. High value — covers business info, blogging settings, site availability, URL mappings, and more.
2. **`updateNavigation()`** — `POST /api/widget/UpdateNavigation`. High value — enables page reordering.
3. **Design read methods** — `getWebsiteFonts()`, `getWebsiteColors()`, etc. Medium value — read-only but useful for design snapshots.
4. **`getAdvancedSettings()`** — `GET /api/config/GetAdvancedSettings`. Low priority — may duplicate data from `getSettings()`.
