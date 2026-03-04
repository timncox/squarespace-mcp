# Squarespace Helper — Claude Code Plugin Idea

## Concept

Turn the Squarespace Helper into a distributable Claude Code plugin (publishable to the Claude plugin marketplace). Users install it, authenticate once, and Claude can directly edit their Squarespace site from the terminal — no browser automation, no WhatsApp, no server needed.

## Core: MCP Server wrapping ContentSaveClient

The `ContentSaveClient` (40+ API methods in `src/services/content-save.ts`) is a perfect fit for an MCP server bundled inside the plugin. Claude gets direct Squarespace editing tools:

```
squarespace:get_page_sections
squarespace:update_text_block
squarespace:add_blank_section
squarespace:create_page
squarespace:delete_page
squarespace:update_image_block
squarespace:update_menu_block
squarespace:update_button_block
squarespace:update_quote_block
squarespace:update_code_block
squarespace:move_section
squarespace:remove_block
squarespace:add_text_block
squarespace:copy_template_section
... (40+ total)
```

Claude calls these directly. No agent pipeline, no Playwright, no conversation state machine.

## Plugin Structure

```
squarespace-plugin/
├── .claude-plugin/
│   └── plugin.json          ← manifest (name, version, author)
├── mcp/
│   └── server.ts            ← wraps ContentSaveClient as MCP tools
├── agents/
│   └── squarespace.md       ← editor agent with full API knowledge
├── skills/
│   ├── setup/SKILL.md       ← /squarespace:setup — authenticate with site
│   └── edit/SKILL.md        ← /squarespace:edit "add a contact section"
└── .mcp.json                ← registers the MCP server
```

## What Translates Well

- All `ContentSaveClient` API methods (text, images, buttons, menus, pages, sections)
- Content strategist logic (blank_api vs template vs manual routing)
- Session cookie management + setup/auth flow
- Skills: `/squarespace:edit`, `/squarespace:plan`, `/squarespace:setup`
- The agent system prompt (knows Squarespace block types, API patterns)

## What Doesn't Translate (stays as separate server)

- WhatsApp/email integration — server-side webhook system
- Playwright browser automation — needs a persistent browser session
- Conversation state machine — built for async messaging, not CLI sessions

## User Experience

```bash
# Install
/plugin install squarespace-helper

# Authenticate (one-time — saves session cookies)
/squarespace:setup

# Edit
/squarespace:edit add a team section with Alice (CEO) and Bob (CTO)
# → Claude calls squarespace:get_page_sections, squarespace:add_blank_section,
#   squarespace:add_text_block (×3), done in ~2 seconds
```

## Build Approach

1. **Extract MCP server** — thin wrapper around `ContentSaveClient`, one tool per public method
2. **Auth flow** — session cookie capture via headless browser (one-time setup), stored in `~/.claude/plugins/squarespace-helper/cookies.json`
3. **Agent** — port the content strategist prompt + blank_api routing logic
4. **Skills** — `/squarespace:edit` invokes the agent with Squarespace tools available
5. **Package** — `plugin.json` manifest, submit to `claude.ai/settings/plugins/submit`

## Key Insight

90% of the value (API-first editing) is fully portable to a plugin. The hard part (ContentSaveClient, block type knowledge, content routing logic) is already built. This is mostly a packaging + MCP wiring job.
