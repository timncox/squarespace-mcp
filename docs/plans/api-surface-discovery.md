# Squarespace API Surface Discovery

**Date**: 2026-03-02
**Site**: grey-yellow-hbxc
**Total endpoints probed**: ~100 across 3 rounds
**Methodology**: Authenticated GET/PUT/POST/PATCH probes using session cookies

## Executive Summary

Probed ~100 potential API endpoints. Found **3 new endpoints** beyond the 2 already known:

| Endpoint | Read | Write | Value |
|----------|------|-------|-------|
| `/api/navigation` | GET ✅ | PUT/PATCH ❌ (405) | **HIGH** — page listing with ordering, collectionIds, enabled status |
| `/api/settings` | GET ✅ | PUT ❌ (400), POST/PATCH ❌ (405) | **HIGH** — 63 site settings fields (SEO, business hours, comments, badge, etc.) |
| `/api/commerce/products` | GET ✅ | — | LOW — empty on non-commerce sites |

**Key finding**: Squarespace's admin APIs are heavily locked down. Most site-wide settings (design, fonts, colors, CSS, redirects, social links, forms, members) have no REST API endpoints. The settings endpoint returns rich data but write operations are rejected — likely managed through WebSocket/Damask internal protocol.

## New Discoveries

### 1. `GET /api/navigation` — Page Navigation Structure

**Response**: Array of 2 nav groups (3,693 bytes)

```
[
  {
    identifier: "mainNav",
    name: "Main Navigation",
    index: false,
    links: [
      {
        title: "About",
        urlId: "about-3",
        typeName: "page",           // "page" | "blog-masonry" etc.
        collectionId: "69a3b7ee...",
        enabled: true,
        passwordProtected: false,
        collectionType: 10,         // 10=page, 1=blog
        isFolder: false,
        ordering: 3,
        updatedOn: 1772337134312,
        pagePermissionType: 1,
        isDraft: false,
        icon: "page"                // "page" | "blog"
      },
      // ...12 links total
    ],
    errors: []
  },
  {
    identifier: "_hidden",
    name: "Not Linked",
    links: [
      { title: "Home", urlId: "home", ... }
    ]
  }
]
```

**Write access**: GET only. PUT returns 405, PATCH returns 405. Page reordering likely requires the Damask editor protocol.

**Use cases**:
- `getNavigation()` — Read navigation structure for page listing (alternative to GetCollections)
- Determine page ordering position, enabled/disabled status, folder structure
- Check if a page is in "Not Linked" section vs main navigation
- Get `collectionType` to distinguish pages (10) from blogs (1)

### 2. `GET /api/settings` — Site Settings (63 fields)

**Response**: Flat JSON object (4,102 bytes) with 63 keys.

**Actionable fields for our use cases**:

| Field | Type | Current Value | Useful? |
|-------|------|---------------|---------|
| `websiteId` | string | `69934978b23b0453e46b6508` | Site identification |
| `ownerId` | string | `54359514e4b060d07debf72f` | Owner identification |
| `country` / `state` | string | `US` / `NY` | Locale info |
| `homepageTitleFormat` | string | `%s` | SEO title template |
| `collectionTitleFormat` | string | `%p — %s` | SEO title template |
| `itemTitleFormat` | string | `%i — %s` | SEO title template |
| `seoHidden` | boolean | `false` | Is site hidden from search? |
| `isCookieBannerEnabled` | boolean | `false` | Cookie consent |
| `businessHours` | object | `{monday:{...},...}` | Each day has `text` + `ranges` |
| `internalContactPhoneNumber` | string | `""` | Contact info |
| `internalContactEmail` | string | `""` | Contact info |
| `commentsEnabled` | boolean | `false` | Global comment toggle |
| `announcementBarSettings` | object | `{}` | Announcement bar config |
| `mobileInfoBarSettings` | object | `{isContactEmailEnabled: false, ...}` | Mobile info bar |
| `storeSettings` | object | 33 keys | Return policy, terms, checkout config |
| `ssBadgeType/Position/Visibility` | number | `1/4/1/1` | "Made with Squarespace" badge |
| `memberAreaNavigationSetting` | string | `replace_main_nav` | Member area nav behavior |
| `socialAccountDisplayOrder` | array[3] | — | Social account ordering |

**Write access**: GET only. PUT returns 400 (empty body), POST/PATCH return 405. Settings modifications likely require the Damask protocol.

### 3. `GET /api/commerce/products` — Product Listings

**Response**: `{ results: [], hasPreviousPage: false, hasNextPage: false }` (58 bytes)

Empty on non-commerce sites. Paginated response structure. Commerce inventory (`/api/commerce/inventory`) and shipping (`/api/commerce/shipping`) return 405 — may need POST.

## Already-Known Endpoints (Confirmed)

| Endpoint | Size | Notes |
|----------|------|-------|
| `GET /api/commondata/GetCollections/` | 10,408 bytes | Collection metadata (already used by ContentSaveClient) |
| `GET /api/site-header-footer` | 6,060 bytes | Header/footer config (already used) |
| `GET/PUT /api/page-sections/{id}` | varies | Page content (already used, core API) |
| `GET/PUT /api/page-sections/{id}/collection/{collectionId}` | varies | Page content with write (already used) |

## Endpoints That Exist But Reject Methods

| Endpoint | GET | POST | PUT | PATCH | Notes |
|----------|-----|------|-----|-------|-------|
| `/api/pages` | 405 | 405 | — | — | Exists but rejects GET/POST |
| `/api/billing` | 405 | 405 | — | — | Billing info (probably needs different auth) |
| `/api/domains` | 405 | 405 | — | — | Domain management |
| `/api/lock-screen` | 405 | — | — | — | Site lock/password screen |
| `/api/commerce/inventory` | 405 | — | — | — | Product inventory |
| `/api/commerce/shipping` | 405 | — | — | — | Shipping config |

These likely require specific payloads, query parameters, or internal authentication tokens not available through session cookies alone.

## Confirmed Non-Existent (404)

The following endpoint families returned 404 across multiple naming variations:

- **Design/Theming**: `/api/site-design`, `/api/design-data`, `/api/design`, `/api/fonts`, `/api/colors`, `/api/less-variables`, `/api/design-variables`, `/api/style`, `/api/styles`, `/api/site-styles`, `/api/custom-css`, `/api/customcss`
- **Redirects**: `/api/url-redirects`, `/api/redirect`, `/api/redirect-rules`
- **Forms**: `/api/form-builder/forms`, `/api/forms`, `/api/form-builder`, `/api/form-submissions`
- **Members**: `/api/members`, `/api/member-areas`, `/api/member-site`
- **Social**: `/api/social-links`, `/api/social-accounts`, `/api/social-account-links`
- **SEO**: `/api/seo`, `/api/seo-data`, `/api/meta`
- **Announcements**: `/api/announcements`, `/api/announcement-bar`, `/api/popups`
- **Content**: `/api/blog`, `/api/blog/posts`, `/api/collections`, `/api/content`, `/api/items`, `/api/blocks`
- **Extensions**: `/api/extensions`, `/api/extension-apps`, `/api/connected-accounts`
- **Scheduling**: `/api/scheduling`, `/api/appointments`, `/api/acuity`
- **Marketing**: `/api/marketing`, `/api/email`, `/api/campaigns`
- **i18n**: `/api/localization`, `/api/i18n`, `/api/locale`, `/api/language`, `/api/translations`
- **Code**: `/api/code-injection`, `/api/custom-files`
- **Other**: `/api/search`, `/api/analytics`, `/api/notifications`, `/api/visitor-data`, `/api/site-badge`, `/api/cookie-consent`, `/api/fluid-engine`, `/api/section-templates`, `/api/block-types`

Note: `/config/design` and `/config/pages` return HTML (the editor shell), not API data.

## Potential ContentSaveClient Methods

Based on discoveries, these **read-only** methods could be added:

### High Priority

| Method | Endpoint | Use Case | Effort |
|--------|----------|----------|--------|
| `getNavigation()` | `GET /api/navigation` | Page listing with ordering, enabled status, folder structure, collectionIds. Richer than GetCollections for nav-aware operations. | Small |
| `getSettings()` | `GET /api/settings` | Read 63 site settings. Useful for: checking SEO status, reading business hours/contact info, badge visibility, cookie banner state. | Small |

### Medium Priority

| Method | Endpoint | Use Case | Effort |
|--------|----------|----------|--------|
| `getProducts()` | `GET /api/commerce/products` | Read product catalog. Only useful for commerce sites. Paginated. | Small |

### Future (If Write Access Found)

These would be high-impact if we discover a write mechanism:

| Method | Endpoint | Impact |
|--------|----------|--------|
| `updateNavigation()` | `/api/navigation` | Page reordering via API instead of browser agent |
| `updateSettings()` | `/api/settings` | SEO settings, business hours, cookie banner, comments, badge — all via API |
| `updateSocialLinks()` | unknown | Social media link management |
| `updateCustomCSS()` | unknown | Custom CSS injection |
| `addUrlRedirect()` | unknown | URL redirect management |

## Key Insights

1. **Squarespace's admin API surface is narrow**. The vast majority of settings are managed through the Damask editor protocol (WebSocket-based), not REST endpoints. Our existing `page-sections` and `site-header-footer` APIs are the main writable REST endpoints.

2. **Navigation is read-only but information-rich**. The `/api/navigation` response gives us page ordering, enabled/disabled status, folder structure, and `collectionType` — useful for intelligent page management without screenshot analysis.

3. **Settings is a goldmine for reading but not writing**. 63 fields covering SEO, business info, comments, store config, and more. Even read-only, this enables better content planning (e.g., "is the cookie banner on?", "what are the business hours?", "is the site SEO-hidden?").

4. **405 endpoints are intriguing**. `/api/pages`, `/api/billing`, `/api/domains`, `/api/lock-screen`, and commerce sub-endpoints exist but reject standard methods. They may need specific Content-Type headers, API tokens, or internal-only authentication.

5. **No design/theming API exists**. Fonts, colors, CSS customization, and design tokens have no REST endpoints. These will always require browser automation.

## Recommended Next Steps

1. **Implement `getNavigation()`** — Add to ContentSaveClient. Use for page listing in skills, pre-flight checks before page operations.
2. **Implement `getSettings()`** — Add to ContentSaveClient. Use for reading business info, SEO status, site configuration.
3. **Add `navigation` and `settings` commands to `sq.ts`** CLI for debugging.
4. **Intercept Damask WebSocket traffic** (future) — To discover the write protocol for settings, navigation reordering, and design changes. Would require Playwright's `page.on('websocket')` listener during editor interactions.
