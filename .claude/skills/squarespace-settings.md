---
name: squarespace-settings
description: >
  Use when changing site-level settings like business identity, contact info,
  page metadata, header/footer configuration, or forms.
---

# Squarespace Site Settings

## Overview

Site-level settings span multiple API endpoints. All methods are on `ContentSaveClient`
from `src/services/content-save.ts`. Types are in `src/services/content-save-types.ts`.

Identity and CSS methods don't need `pageSectionsId`/`collectionId` — they operate site-wide.

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

## CLI Commands

### Existing

```bash
tsx scripts/sq.ts snapshot    --site <id> --page <slug>   # View page sections JSON
```

### Coming Soon

| Command | Usage |
|---------|-------|
| `site-identity` | `tsx scripts/sq.ts site-identity --site <id> [--get] [--set-phone <str>] [--set-email <str>]` |
| `update-metadata` | `tsx scripts/sq.ts update-metadata --site <id> --page <slug> [--title <str>] [--seo-title <str>]` |
| `list-pages` | `tsx scripts/sq.ts list-pages --site <id> [--type page\|blog\|all]` |

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

---

## Important Notes

- **All methods never throw** — they return `{ success: false, error: '...' }` on failure.
- **Identity spans two endpoints** — `businessName`/`address`/`siteTitle` come from `/api/rest/websites/mine`, while `phone`/`email` come from `/api/settings`. The client handles this transparently.
- **Footer is NOT page sections** — footer sections are embedded in the `/api/site-header-footer` config. Always use `saveHeaderFooter()`, never `savePageSections()`, for footer edits.
- **Homepage slug normalization** — `getPageMetadata()` normalizes "homepage", "home-page", "landing", "index", "main" to "home" automatically.
- **Page visibility** — set `enabled: false` via `updatePageMetadata()` to hide a page from navigation without deleting it.
- **Session required** — all methods need authenticated session cookies (see squarespace-setup skill).
