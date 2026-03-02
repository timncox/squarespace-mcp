---
name: squarespace-setup
description: >
  Use when Squarespace API calls fail with auth errors, or for first-time setup.
  Creates ~/.squarespace/ config and runs the login flow to save session cookies.
---

## Step 1: Check for config file

```bash
ls ~/.squarespace/config.json 2>/dev/null && cat ~/.squarespace/config.json
```

If the file does not exist, ask the user:
- Their Squarespace account email
- Their Squarespace account password

Then create the config:

```bash
mkdir -p ~/.squarespace
cat > ~/.squarespace/config.json << 'EOF'
{
  "email": "<email>",
  "password": "<password>"
}
EOF
```

Do not log or display the password after writing it.

## Alternative: copy an existing session

If the project already has a session at `storage/auth/sqsp-session.json`, skip the login flow and copy it:

```bash
mkdir -p ~/.squarespace/cookies
cp storage/auth/sqsp-session.json ~/.squarespace/cookies/<subdomain>.json
```

Then jump to Step 4 to verify it.

## Step 2: Identify the site to log in to

Ask the user which site they want to log in to if they have not already specified one. The `--site` flag accepts a client ID from `config/sites.json`, a client alias, or a raw Squarespace subdomain (e.g., `smyth-tavern` for `smyth-tavern.squarespace.com`).

To see available sites:

```bash
cat config/sites.json
```

## Step 3: Run the login flow

```bash
tsx scripts/sq.ts login --site <subdomain>
```

Warn the user: this opens a headed (visible) browser window. They may need to complete a CAPTCHA or two-factor auth challenge manually. The browser will close automatically once cookies are saved.

Cookies are written to `~/.squarespace/cookies/<subdomain>.json`.

## Step 4: Verify the session

Run a snapshot on the home page to confirm the session is working:

```bash
tsx scripts/sq.ts snapshot --site <id> --page home
```

If this returns valid JSON, the setup is complete. Tell the user their session is active.

If it fails with "Could not resolve pageSectionsId", the site may be private or on a trial plan. Tell the user they will need to provide `--psid` and `--colid` flags for that site's pages. These IDs appear in the Squarespace editor URL when viewing a page in edit mode:

```
https://<subdomain>.squarespace.com/config/pages/<pageSectionsId>?collectionId=<collectionId>
```

For convenience, pre-seed the page ID cache so future commands don't need the flags:

```bash
python3 -c "
import json, time, os
path = os.path.expanduser('~/.squarespace/page-id-cache.json')
try:
    cache = json.load(open(path))
except:
    cache = {}
cache['<subdomain>:<slug>'] = {
    'collectionId': '<collectionId>',
    'pageSectionsId': '<pageSectionsId>',
    'cachedAt': int(time.time() * 1000)
}
json.dump(cache, open(path, 'w'), indent=2)
"
```

## Session lifetime

Sessions work reliably well past the 24h warning — 77-hour and 90-hour sessions have been confirmed working. The `checkSessionHealth()` static method warns at 24h, but do not preemptively re-login. Check with `sq.ts snapshot` first — only re-run the login flow when API calls actually start returning 401 errors.

## Page ID cache management

`getPageIds()` caches resolved `pageSectionsId` and `collectionId` values in `~/.squarespace/page-id-cache.json`. For public/published sites, IDs are resolved automatically from the site's public JSON. For private or trial sites, automatic resolution may fail — pass `--psid` and `--colid` flags manually:

```bash
tsx scripts/sq.ts snapshot --site <id> --page <slug> --psid <pageSectionsId> --colid <collectionId>
```

These IDs appear in the Squarespace editor URL:
```
https://<subdomain>.squarespace.com/config/pages/<pageSectionsId>?collectionId=<collectionId>
```

Run `snapshot` first to verify IDs are correct before running other commands. Once resolved (manually or automatically), IDs are cached and reused for subsequent commands.

## Next steps

After setup is complete, use these task-oriented skills for specific workflows:

- **squarespace-snapshot** — View current page content and structure
- **squarespace-create** — Add new sections, blocks, and pages
- **squarespace-edit** — Modify existing content (text, images, menus, etc.)
- **squarespace-blog** — Create and manage blog posts
- **squarespace-design** — Section styling, themes, CSS, and visual changes
- **squarespace-settings** — Page metadata, SEO, navigation, and site config
