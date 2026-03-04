# Social Links API Support — Design

**Date:** 2026-03-04
**Status:** Approved

## Discovery

Social link URLs are managed via non-OAuth accounts, not connected OAuth accounts as previously assumed. Confirmed by Playwright traffic capture on tim-cox.squarespace.com.

## API Endpoints

| Action | Method | Endpoint | Content-Type | Auth |
|--------|--------|----------|-------------|------|
| List | GET | `/api/rest/social-accounts` | — | Cookie |
| Create | POST | `/api/config/CreateNonOAuthAccount` | `application/x-www-form-urlencoded` | X-CSRF-Token |
| Delete | DELETE | `/api/rest/social-accounts/{id}` | — | X-CSRF-Token |

### Service IDs

| ID | Platform | serviceName |
|----|----------|-------------|
| 60 | Facebook | `facebook-unauth` |
| 62 | Twitter/X | `twitter-unauth` |
| 64 | Instagram | `instagram-unauth` |
| 65 | LinkedIn | `linkedin-unauth` |
| 69 | YouTube | `youtube-unauth` |

### CreateNonOAuthAccount Request

Form-encoded body: `service=64&username=Instagram&profileUrl=http%3A%2F%2Finstagram.com%2Ftimcox`

Response:
```json
{
  "account": {
    "serviceId": 64,
    "screenname": "Instagram",
    "profileUrl": "http://instagram.com/timcox",
    "id": "69a79c93e3ffe8373b969ddd",
    "websiteId": "5f7c98d5b6fdce54b4c628af",
    "iconEnabled": true,
    "serviceName": "instagram-unauth",
    "pushEnabled": true,
    "pullEnabled": false
  }
}
```

### Delete Response

`DELETE /api/rest/social-accounts/{id}` → `{"success": true}`

### List Response

`GET /api/rest/social-accounts` → `{"results": [...accounts], "hasPreviousPage": false, "hasNextPage": false}`

## ContentSaveClient Methods (3 new)

1. **`getSocialAccounts()`** — GET list, return typed array
2. **`addSocialAccount(serviceId, username, profileUrl)`** — POST form-encoded, return new account
3. **`removeSocialAccount(accountId)`** — DELETE by ID

Update = delete + recreate (matches editor behavior).

## MCP Tools (3 new in site.ts)

| Tool | Params | Description |
|------|--------|-------------|
| `sq_list_social_links` | `siteId` | List all social link accounts |
| `sq_add_social_link` | `siteId, service, username, profileUrl` | Add social link. `service` accepts name or numeric ID |
| `sq_remove_social_link` | `siteId, accountId` | Remove social link by account ID |

## Service Name Resolution

`SOCIAL_SERVICE_MAP` constant maps platform names to IDs:
- `"facebook"` → 60, `"twitter"` / `"x"` → 62, `"instagram"` → 64, `"linkedin"` → 65, `"youtube"` → 69
- Raw numeric IDs also accepted for unmapped services

## Testing

- Unit tests for 3 ContentSaveClient methods (mock fetch)
- MCP tool registration + handler tests (mock session)
