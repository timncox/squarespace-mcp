---
name: squarespace-settings
description: >
  Use when changing site-level settings like business identity, contact info,
  page metadata, header/footer configuration, navigation, code injection, or forms.
---

# Squarespace Site Settings

## Overview

Site-level settings span multiple API endpoints. All methods are on `ContentSaveClient`
from `src/services/content-save.ts`. Types are in `src/services/content-save-types.ts`.

Identity, navigation, settings, code injection, and footer methods don't need
`pageSectionsId`/`collectionId` — they operate site-wide.

---

## Site Identity

### getSiteIdentity()

```typescript
async getSiteIdentity(): Promise<SiteIdentityResult>
```

Fetches from two endpoints in parallel:
- `GET /api/rest/websites/mine` — businessName, address, address2, siteTitle
- `GET /api/settings` — phone, email

```typescript
interface SiteIdentityData {
  businessName?: string;   // location.addressTitle
  address?: string;        // location.addressLine1
  address2?: string;       // location.addressLine2
  phone?: string;          // internalContactPhoneNumber
  email?: string;          // internalContactEmail
  siteTitle?: string;      // siteTitle
}

interface SiteIdentityResult {
  success: boolean;
  data?: SiteIdentityData;
  updatedFields?: string[];  // present on update responses
  error?: string;
}
```

### updateSiteIdentity()

```typescript
async updateSiteIdentity(updates: SiteIdentityUpdateOptions): Promise<SiteIdentityResult>
```

```typescript
interface SiteIdentityUpdateOptions {
  businessName?: string;
  address?: string;
  address2?: string;
  phone?: string;
  email?: string;
  siteTitle?: string;
}
```

Read-modify-write pattern. Only PUTs to endpoints where fields are being changed
(e.g., if only `phone` is updated, only `/api/settings` is written).

---

## Header & Footer

### getHeaderFooter()

```typescript
async getHeaderFooter(): Promise<{
  success: boolean;
  config?: HeaderFooterConfig;
  error?: string;
}>
```

```typescript
interface HeaderFooterConfig {
  footer?: {
    pageSectionsId?: string;
    [key: string]: unknown;
  };
  header?: Record<string, unknown>;
  [key: string]: unknown;
}
```

Endpoint: `GET /api/site-header-footer`

### getFooterSections()

```typescript
async getFooterSections(): Promise<{
  success: boolean;
  sections?: PageSection[];
  pageSectionsId?: string;
  collectionId?: string;
  error?: string;
}>
```

Two-step process:
1. Calls `getHeaderFooter()` to find the footer's `pageSectionsId`
2. Calls `getPageSections(footerPsId)` to fetch actual section data

### saveHeaderFooter()

```typescript
async saveHeaderFooter(
  config: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }>
```

Endpoint: `PUT /api/site-header-footer`

**IMPORTANT**: The footer's sections are embedded in the header-footer config, not in
regular page sections. Use `saveHeaderFooter()` to save footer changes — NOT
`savePageSections()`. This is a common mistake.

---

## Page Metadata

### listCollections()

```typescript
async listCollections(): Promise<CollectionInfo[]>
```

Returns all pages, blogs, galleries, stores, folders. Never throws — returns `[]` on error.

```typescript
interface CollectionInfo {
  id: string;
  urlId: string;        // URL slug
  title: string;
  type: number;          // 1=page, 2=blog, 5=store, 7=gallery, 11=folder, 12=index
  typeName: string;
  itemCount?: number;
  enabled?: boolean;
  ordering?: number;
  navigationTitle?: string;
  description?: string;
}
```

### getPageMetadata()

```typescript
async getPageMetadata(slug: string): Promise<PageMetadata | null>
```

Wraps `listCollections()` with slug normalization. Normalizes homepage variants
("homepage", "home-page", "landing", "index", "main" -> "home").

```typescript
interface PageMetadata {
  collectionId: string;
  urlId: string;
  title: string;
  type: number;
  typeName: string;
  enabled?: boolean;
  navigationTitle?: string;
}
```

### updatePageMetadata()

```typescript
async updatePageMetadata(
  collectionId: string,
  updates: PageMetadataUpdateOptions,
): Promise<PageMetadataUpdateResult>
```

```typescript
interface PageMetadataUpdateOptions {
  title?: string;
  urlId?: string;           // Change the URL slug
  description?: string;
  seoTitle?: string;
  seoDescription?: string;
  navigationTitle?: string;  // Title shown in site navigation
  enabled?: boolean;         // Show/hide page
}

interface PageMetadataUpdateResult {
  success: boolean;
  collectionId?: string;
  updatedFields?: string[];
  error?: string;
}
```

Endpoint: `PUT /api/collections/{collectionId}`

---

## Forms

### getAvailableForms()

```typescript
async getAvailableForms(): Promise<FormListResult>
```

```typescript
interface FormInfo {
  id: string;
  name: string;
}

interface FormListResult {
  success: boolean;
  forms: FormInfo[];
  error?: string;
}
```

Endpoint: `GET /api/rolodex/1/forms`

---

## Navigation

### getNavigation()

```typescript
async getNavigation(): Promise<NavigationResult>
```

Returns the site's page structure (main navigation + not-linked pages).

```typescript
interface NavigationItem {
  id: string;
  title: string;
  urlSlug: string;
  collectionId?: string;
  collectionType?: number;  // 10=page, 1=blog
  enabled?: boolean;
  isDraft?: boolean;
  isFolder?: boolean;
  ordering?: number;
  type?: string;
  children?: NavigationItem[];
}

interface NavigationData {
  mainNavigation: NavigationItem[];
  notLinked: NavigationItem[];
}

interface NavigationResult {
  success: boolean;
  data?: NavigationData;
  error?: string;
}
```

Endpoint: `GET /api/navigation`

### updateNavigation()

```typescript
async updateNavigation(
  fieldName: string,
  items: UpdateNavigationItem[],
): Promise<UpdateNavigationResult>
```

Reorders pages in the navigation. `fieldName` is `"mainNav"` for main navigation or `"_hidden"` for not-linked pages. The `items` array must contain full page metadata for every page in the section being reordered.

```typescript
interface UpdateNavigationItem {
  title: string;
  urlId: string;
  typeName: string;
  collectionId: string;
  enabled: boolean;
  passwordProtected: boolean;
  collectionType: number;
  isFolder: boolean;
  ordering: number;
  updatedOn: number;
  pagePermissionType: number;
  isDraft: boolean;
  items: UpdateNavigationItem[];  // children (folders)
  id: string;
}
```

Endpoint: `POST /api/widget/UpdateNavigation` (requires `templateId` from `GET /api/template/GetTemplate`).

**Typical workflow**: `getNavigation()` → rearrange items → `updateNavigation('mainNav', reorderedItems)`

---

## Site Settings

### getSettings()

```typescript
async getSettings(): Promise<SettingsResult>
```

Returns the full site settings object (~63 fields).

```typescript
interface SiteSettings {
  [key: string]: unknown;
  siteTitle?: string;
  siteDescription?: string;
  siteTagLine?: string;
  businessName?: string;
  contactEmail?: string;
  contactPhoneNumber?: string;
  internalContactPhoneNumber?: string;
  internalContactEmail?: string;
  businessHours?: Record<string, unknown>;
  commentsEnabled?: boolean;
  isCookieBannerEnabled?: boolean;
  seoHidden?: boolean;
  homepageTitleFormat?: string;
  collectionTitleFormat?: string;
  announcementBarSettings?: Record<string, unknown>;
}

interface SettingsResult {
  success: boolean;
  data?: SiteSettings;
  updatedFields?: string[];  // present on update responses
  error?: string;
}
```

Endpoint: `GET /api/settings`

### updateSettings()

```typescript
async updateSettings(fields: Partial<SiteSettings>): Promise<SettingsResult>
```

Read-modify-write on `PUT /api/settings` (confirmed working, returns 200). Merges provided fields into the current settings and PUTs the full object back.

Works reliably for: `siteTitle`, `siteDescription`, `siteTagLine`, `commentsEnabled`, `isCookieBannerEnabled`, `seoHidden`, `homepageTitleFormat`, `collectionTitleFormat`. Some deeply nested fields or read-only system fields may cause 400 errors — test unfamiliar fields on a staging site first.

---

## Code Injection

### getCodeInjection()

```typescript
async getCodeInjection(): Promise<{
  success: boolean;
  data?: CodeInjectionData;
  error?: string;
}>
```

Reads from `GET /api/settings` and extracts the `codeInjection` field.
Falls back to `injectHeader`/`injectFooter` top-level fields if `codeInjection` is absent.

```typescript
interface CodeInjectionData {
  header: string;
  footer: string;
}
```

### saveCodeInjection()

```typescript
async saveCodeInjection(
  header?: string,
  footer?: string,
): Promise<{ success: boolean; error?: string }>
```

Endpoint: `POST /api/config/SaveInjectionSettings?crumb=...`

Body: `{ injectHeader: string, injectFooter: string }`

Pass only the fields you want to update — omitted fields are left unchanged.

---

## Advanced Settings (URL Redirects / Mappings)

### getAdvancedSettings()

```typescript
async getAdvancedSettings(): Promise<AdvancedSettingsResult>
```

Returns URL redirects/mappings and other advanced configuration.

Endpoint: `GET /api/config/GetAdvancedSettings`

### saveAdvancedSettings()

```typescript
async saveAdvancedSettings(data: Record<string, string>): Promise<AdvancedSettingsSaveResult>
```

Saves URL redirects and other advanced settings. Body is **form-encoded** (`application/x-www-form-urlencoded`), e.g., `mappings=...` — NOT JSON (JSON returns 415).

Endpoint: `POST /api/config/SaveAdvancedSettings`

---

## CLI Commands

| Command | Usage |
|---------|-------|
| `site-identity` | `tsx scripts/sq.ts site-identity --site <id> [--name <str>] [--phone <str>] [--email <str>] [--address <str>]` |
| `update-metadata` | `tsx scripts/sq.ts update-metadata --site <id> --page <slug> [--title <str>] [--description <str>] [--seo-title <str>] [--seo-description <str>]` |
| `list-pages` | `tsx scripts/sq.ts list-pages --site <id>` |
| `navigation` | `tsx scripts/sq.ts navigation --site <id>` |
| `reorder-nav` | `tsx scripts/sq.ts reorder-nav --site <id> --page-ids <id1,id2,id3>` |
| `settings` | `tsx scripts/sq.ts settings --site <id>` |
| `footer` | `tsx scripts/sq.ts footer --site <id> [--search <text> --text <newText>]` |
| `code-injection` | `tsx scripts/sq.ts code-injection --site <id> [--header <html>] [--footer <html>]` |
| `get-advanced-settings` | `tsx scripts/sq.ts get-advanced-settings --site <id>` |
| `set-advanced-settings` | `tsx scripts/sq.ts set-advanced-settings --site <id> --file <path>` |
| `snapshot` | `tsx scripts/sq.ts snapshot --site <id> --page <slug>` |

**Notes:**
- `site-identity` with no update flags reads current identity; with flags updates those fields
- `footer` with no flags reads footer sections JSON; with `--search`+`--text` patches a text block
- `code-injection` with no flags reads current injection; with `--header`/`--footer` saves new scripts
- `reorder-nav` reorders main navigation pages by providing collection IDs in the desired order
- `get-advanced-settings` / `set-advanced-settings` manage URL redirects and mappings

---

## Examples

### Example 1: Update business phone number

```typescript
import { createContentSaveClient } from '../src/services/content-save.js';

const client = createContentSaveClient('my-site', cookiePath);

// Read current identity
const { data } = await client.getSiteIdentity();
console.log(`Current phone: ${data?.phone}`);

// Update phone
const result = await client.updateSiteIdentity({
  phone: '+1-555-123-4567',
});
console.log(`Updated fields: ${result.updatedFields}`);
```

### Example 2: Change page SEO metadata

```typescript
const client = createContentSaveClient('my-site', cookiePath);

// Find the page
const meta = await client.getPageMetadata('about');
if (!meta) throw new Error('Page not found');

// Update SEO
await client.updatePageMetadata(meta.collectionId, {
  seoTitle: 'About Us | My Business',
  seoDescription: 'Learn about our team and mission.',
});
```

### Example 3: List all pages and their types

```typescript
const client = createContentSaveClient('my-site', cookiePath);
const collections = await client.listCollections();

for (const col of collections) {
  console.log(`${col.typeName.padEnd(8)} | ${col.title} (/${col.urlId}) ${col.enabled ? '' : '[hidden]'}`);
}
```

### Example 4: Read footer sections

```typescript
const client = createContentSaveClient('my-site', cookiePath);
const footer = await client.getFooterSections();

if (footer.success && footer.sections) {
  for (const section of footer.sections) {
    console.log(`Footer section: ${section.id}`);
  }
}
```

### Example 5: Get site navigation structure

```typescript
const client = createContentSaveClient('my-site', cookiePath);
const nav = await client.getNavigation();

if (nav.success && nav.data) {
  console.log('Main navigation:');
  for (const item of nav.data.mainNavigation) {
    console.log(`  ${item.title} (/${item.urlSlug}) ${item.enabled ? '' : '[hidden]'}`);
    if (item.children) {
      for (const child of item.children) {
        console.log(`    └─ ${child.title} (/${child.urlSlug})`);
      }
    }
  }
  console.log('Not linked:');
  for (const item of nav.data.notLinked) {
    console.log(`  ${item.title} (/${item.urlSlug})`);
  }
}
```

### Example 6: Read and update code injection

```typescript
const client = createContentSaveClient('my-site', cookiePath);

// Read current injection
const current = await client.getCodeInjection();
console.log(`Header (${current.data?.header.length} chars):`, current.data?.header);
console.log(`Footer (${current.data?.footer.length} chars):`, current.data?.footer);

// Add a tracking script to the header
await client.saveCodeInjection(
  '<script>/* analytics */</script>',
  undefined,  // leave footer unchanged
);
```

---

## Important Notes

- **All methods never throw** — they return `{ success: false, error: '...' }` on failure.
- **Identity spans two endpoints** — `businessName`/`address`/`siteTitle` come from `/api/rest/websites/mine`, while `phone`/`email` come from `/api/settings`. The client handles this transparently.
- **Footer is NOT page sections** — footer sections are embedded in the `/api/site-header-footer` config. Always use `saveHeaderFooter()`, never `savePageSections()`, for footer edits.
- **Homepage slug normalization** — `getPageMetadata()` normalizes "homepage", "home-page", "landing", "index", "main" to "home" automatically.
- **Page visibility** — set `enabled: false` via `updatePageMetadata()` to hide a page from navigation without deleting it.
- **Navigation supports read AND write** — `getNavigation()` reads the page tree, `updateNavigation()` reorders pages via `POST /api/widget/UpdateNavigation`. The `reorder-nav` CLI command provides a simpler interface.
- **updateSettings() works for common fields** — `PUT /api/settings` returns 200 for fields like `siteTitle`, `siteDescription`, `siteTagLine`, `commentsEnabled`. Some nested or system fields may return 400.
- **Code injection uses a different save endpoint** — reads from `/api/settings` but saves via `POST /api/config/SaveInjectionSettings`.
- **Session required** — all methods need authenticated session cookies (see squarespace-setup skill).
