/**
 * MCP Tools — Site-wide settings
 *
 * sq_get_settings: Read site settings
 * sq_update_settings: Write site settings (partial update)
 * sq_get_design: Read fonts + colors + tweaks
 * sq_update_design: Update fonts, colors, and/or tweaks
 * sq_get_code_injection: Read header/footer code injection
 * sq_update_code_injection: Save header/footer scripts
 * sq_update_css: Update custom CSS (full replacement)
 * sq_patch_css: Patch custom CSS (surgical add/replace/remove)
 * sq_list_social_links: List social link accounts
 * sq_add_social_link: Add a social link by URL
 * sq_remove_social_link: Remove a social link account
 * sq_get_site_identity: Read site identity (business name, address, title, phone, email)
 * sq_update_site_identity: Update site identity fields
 * sq_get_advanced_settings: Read advanced settings including URL redirects
 * sq_save_advanced_settings: Save advanced settings (URL redirects, etc.)
 * sq_get_header_footer_config: Read full header/footer configuration
 * sq_update_header_footer_config: Update header/footer configuration (read-modify-write)
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient, listSites } from '../session.js';

export function registerSiteTools(server: McpServer) {
  // ── sq_list_sites ─────────────────────────────────────────────────────────
  server.registerTool('sq_list_sites', {
    description:
      'List all configured Squarespace sites. Returns site ID, name, subdomain URL, aliases, and custom domain for each site. ' +
      'Use this to discover available sites before calling other tools. ' +
      'Any of the returned identifiers (id, name, alias, subdomain) can be used as the siteId parameter in other tools.',
    inputSchema: {},
  }, async () => {
    try {
      const sites = await listSites();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(sites, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_settings ─────────────────────────────────────────────────────────
  server.registerTool('sq_get_settings', {
    description: 'Read the full site settings object for a Squarespace site.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getSettings();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to get settings'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_settings ──────────────────────────────────────────────────────
  server.registerTool('sq_update_settings', {
    description: 'Update site settings with a partial object. Only provided fields are changed.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      updates: z.record(z.unknown()).describe('Partial settings object with fields to update'),
    },
  }, async ({ siteId, updates }) => {
    try {
      const client = getClient(siteId);
      const result = await client.updateSettings(updates);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update settings'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_design ───────────────────────────────────────────────────────────
  server.registerTool('sq_get_design', {
    description: 'Read site design settings: fonts, colors, and template tweaks in a single call.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const [fontsResult, colorsResult, tweaksResult] = await Promise.all([
        client.getWebsiteFonts(),
        client.getWebsiteColors(),
        client.getTemplateTweakSettings(),
      ]);

      const errors: string[] = [];
      if (!fontsResult.success) errors.push(`fonts: ${fontsResult.error ?? 'unknown error'}`);
      if (!colorsResult.success) errors.push(`colors: ${colorsResult.error ?? 'unknown error'}`);
      if (!tweaksResult.success) errors.push(`tweaks: ${tweaksResult.error ?? 'unknown error'}`);

      if (errors.length === 3) {
        return {
          content: [{ type: 'text' as const, text: `Error: All design reads failed — ${errors.join('; ')}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            fonts: fontsResult.success ? fontsResult.data : null,
            colors: colorsResult.success ? colorsResult.data : null,
            tweaks: tweaksResult.success ? tweaksResult.data : null,
            ...(errors.length > 0 ? { warnings: errors } : {}),
          }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_design ────────────────────────────────────────────────────────
  server.registerTool('sq_update_design', {
    description: 'Update site design: fonts, colors, and/or template tweaks. Pass only the fields you want to change.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      font: z.object({
        fontName: z.string().describe('Font name (e.g. "heading-font", "body-font")'),
        updates: z.object({
          fontFamily: z.string().optional(),
          fontWeight: z.string().optional(),
          fontStyle: z.string().optional(),
          textTransform: z.string().optional(),
          letterSpacing: z.string().optional(),
          lineHeight: z.string().optional(),
        }).describe('Font property updates'),
      }).optional().describe('Update a single font by name'),
      color: z.object({
        colorId: z.string().describe('Palette color ID (e.g. "accent", "white", "darkAccent")'),
        hsl: z.object({
          hue: z.number(),
          saturation: z.number(),
          lightness: z.number(),
        }).describe('HSL color values'),
      }).optional().describe('Update a single palette color'),
      tweaks: z.record(z.unknown()).optional().describe('Template tweak key-value pairs to update'),
    },
  }, async ({ siteId, font, color, tweaks }) => {
    try {
      const client = getClient(siteId);
      const results: Record<string, any> = {};

      if (font) {
        const fontResult = await client.updateFont(font.fontName, font.updates as any);
        results.font = { success: fontResult.success, error: fontResult.error ?? null };
      }

      if (color) {
        const colorResult = await client.updatePaletteColor(color.colorId, color.hsl);
        results.color = { success: colorResult.success, error: colorResult.error ?? null };
      }

      if (tweaks) {
        const tweakResult = await client.setTemplateTweakSettings(tweaks as Record<string, string>);
        results.tweaks = { success: tweakResult.success, error: tweakResult.error ?? null };
      }

      const allSucceeded = Object.values(results).every((r: any) => r.success);
      const anyFailed = Object.values(results).some((r: any) => !r.success);

      if (Object.keys(results).length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Error: No design updates provided. Pass font, color, and/or tweaks.' }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: allSucceeded, results }, null, 2),
        }],
        ...(anyFailed ? { isError: true } : {}),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_code_injection ───────────────────────────────────────────────────
  server.registerTool('sq_get_code_injection', {
    description: 'Read the header and footer code injection scripts for a Squarespace site.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getCodeInjection();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to get code injection'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_code_injection ────────────────────────────────────────────────
  server.registerTool('sq_update_code_injection', {
    description: 'Save header and/or footer code injection scripts.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      header: z.string().optional().describe('Header injection HTML/JS (injected in <head>)'),
      footer: z.string().optional().describe('Footer injection HTML/JS (injected before </body>)'),
    },
  }, async ({ siteId, header, footer }) => {
    try {
      const client = getClient(siteId);
      const result = await client.saveCodeInjection(header, footer);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to save code injection'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_css ───────────────────────────────────────────────────────────
  server.registerTool('sq_update_css', {
    description: 'Update the custom CSS for a Squarespace site. Replaces all custom CSS with the provided content.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      css: z.string().describe('Full custom CSS content to save'),
    },
  }, async ({ siteId, css }) => {
    try {
      const client = getClient(siteId);
      const result = await client.saveCustomCSS(css);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to save custom CSS'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_patch_css ─────────────────────────────────────────────────────────
  server.registerTool('sq_patch_css', {
    description: 'Patch custom CSS without replacing everything. Supports add (append new rule), replace (update existing rule by selector), and remove (delete rule by selector). Safer than sq_update_css for targeted changes.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      operations: z.array(z.object({
        action: z.enum(['add', 'replace', 'remove']).describe('add=append new rule, replace=update rule by selector, remove=delete rule by selector'),
        selector: z.string().optional().describe('CSS selector to find (required for replace/remove)'),
        css: z.string().optional().describe('Full CSS rule for add, or replacement rule body for replace'),
      })).describe('Array of CSS patch operations to apply in order'),
    },
  }, async ({ siteId, operations }) => {
    try {
      const client = getClient(siteId);
      const result = await client.patchCustomCSS(operations);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to patch CSS'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, appliedOps: result.appliedOps }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── Social Links ────────────────────────────────────────────────────────

  const SOCIAL_SERVICE_MAP: Record<string, number> = {
    facebook: 60,
    twitter: 62,
    x: 62,
    instagram: 64,
    linkedin: 65,
    youtube: 69,
  };

  // ── sq_list_social_links ────────────────────────────────────────────────
  server.registerTool('sq_list_social_links', {
    description: 'List all social link accounts for a site. Returns account IDs, platform names, and profile URLs.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getSocialAccounts();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to list social accounts'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_add_social_link ──────────────────────────────────────────────────
  server.registerTool('sq_add_social_link', {
    description: 'Add a social link account by URL. The link appears in all Social Links blocks on the site. To update an existing link, remove the old one first, then add the new one.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      service: z.string().describe('Platform name (facebook, twitter, x, instagram, linkedin, youtube) or numeric service ID'),
      username: z.string().describe('Display name for the account (e.g. "Instagram", "My YouTube")'),
      profileUrl: z.string().describe('Full URL to the social profile (e.g. "https://instagram.com/myaccount")'),
    },
  }, async ({ siteId, service, username, profileUrl }) => {
    try {
      // Resolve service name to ID
      const serviceId = SOCIAL_SERVICE_MAP[service.toLowerCase()] ?? parseInt(service, 10);
      if (isNaN(serviceId)) {
        return {
          content: [{ type: 'text' as const, text: `Error: Unknown service "${service}". Use: facebook, twitter, x, instagram, linkedin, youtube, or a numeric service ID.` }],
          isError: true,
        };
      }

      const client = getClient(siteId);
      const result = await client.addSocialAccount(serviceId, username, profileUrl);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to add social account'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.data, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_remove_social_link ───────────────────────────────────────────────
  server.registerTool('sq_remove_social_link', {
    description: 'Remove a social link account by its ID. Use sq_list_social_links first to find the account ID.',
    inputSchema: {
      siteId: z.string().describe('Site identifier (id, name, alias, or subdomain)'),
      accountId: z.string().describe('The social account ID to remove (from sq_list_social_links)'),
    },
  }, async ({ siteId, accountId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.removeSocialAccount(accountId);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to remove social account'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, removedAccountId: accountId }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_site_identity ────────────────────────────────────────────────
  server.registerTool('sq_get_site_identity', {
    description: 'Get site identity info: business name, address, site title, phone, email.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getSiteIdentity();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_site_identity ─────────────────────────────────────────────
  server.registerTool('sq_update_site_identity', {
    description: 'Update site identity: business name, address, site title, phone, email. Only provided fields are changed.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      businessName: z.string().optional().describe('Business name'),
      address: z.string().optional().describe('Address line 1'),
      address2: z.string().optional().describe('Address line 2'),
      siteTitle: z.string().optional().describe('Site title'),
      phone: z.string().optional().describe('Contact phone number'),
      email: z.string().optional().describe('Contact email address'),
    },
  }, async ({ siteId, businessName, address, address2, siteTitle, phone, email }) => {
    try {
      const client = getClient(siteId);
      const result = await client.updateSiteIdentity({ businessName, address, address2, siteTitle, phone, email });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_advanced_settings ────────────────────────────────────────────
  server.registerTool('sq_get_advanced_settings', {
    description: 'Get advanced site settings including URL redirect mappings (301/302). Returns raw settings object.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getAdvancedSettings();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_list_color_themes ─────────────────────────────────────────────
  server.registerTool('sq_list_color_themes', {
    description: 'List all color themes on the site with their names and number of variable mappings. Themes are used by sections (via sectionTheme) to control colors. Use sq_get_design for full palette and theme details.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.listColorThemes();

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to list color themes'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_color_theme ───────────────────────────────────────────
  server.registerTool('sq_update_color_theme', {
    description: 'Update a color theme\'s variable-to-color mappings. Changes how a theme (e.g., "dark") maps CSS variables to palette colors. Use sq_list_color_themes to see available themes, and sq_get_design to see palette color IDs and current mappings.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      themeName: z.string().describe('Theme name to update (e.g., "white", "light", "dark", "black")'),
      mappings: z.array(z.object({
        variableName: z.string().describe('CSS variable name (e.g., "paragraphSmallColor", "headingLargeColor")'),
        colorName: z.string().describe('Palette color ID to map to (e.g., "white", "black", "accent")'),
        alphaModifier: z.number().optional().describe('Alpha/opacity modifier 0-1 (default: 1)'),
      })).describe('Variable-to-color mappings to update. Only specified mappings change; others are preserved.'),
    },
  }, async ({ siteId, themeName, mappings }) => {
    try {
      const client = getClient(siteId);
      const result = await client.updateColorTheme(themeName, mappings);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to update color theme'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_save_advanced_settings ───────────────────────────────────────────
  server.registerTool('sq_save_advanced_settings', {
    description: 'Save advanced site settings. Primary use: URL redirects (301/302). Get current settings via sq_get_advanced_settings, modify the mappings field, then save back. The mappings value must be a JSON string.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      mappings: z.string().optional().describe('JSON string of URL redirect mappings array. Each mapping: {from, to, statusCode (301 or 302)}'),
      data: z.record(z.string()).optional().describe('Raw key-value pairs to save (alternative to mappings — for other advanced settings)'),
    },
  }, async ({ siteId, mappings, data }) => {
    try {
      const client = getClient(siteId);
      const payload: Record<string, string> = data ?? {};
      if (mappings !== undefined) payload.mappings = mappings;
      if (Object.keys(payload).length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: Must provide mappings or data to save' }], isError: true };
      }
      const result = await client.saveAdvancedSettings(payload);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        ...(result.success ? {} : { isError: true }),
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_get_header_footer_config ───────────────────────────────────────────
  server.registerTool('sq_get_header_footer_config', {
    description:
      'Read the full header and footer configuration including layout, background, navigation style, and all design properties. ' +
      'Returns the raw API response from /api/site-header-footer.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
    },
  }, async ({ siteId }) => {
    try {
      const client = getClient(siteId);
      const result = await client.getHeaderFooter();

      if (!result.success || !result.config) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${result.error ?? 'Failed to get header/footer config'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result.config, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  // ── sq_update_header_footer_config ────────────────────────────────────────
  server.registerTool('sq_update_header_footer_config', {
    description:
      'Update header and/or footer configuration. Uses read-modify-write: reads current config, merges your updates, writes back. ' +
      'Use sq_get_header_footer_config first to see available fields. ' +
      'Common fields include layout type, background color, logo settings, and navigation style.',
    inputSchema: {
      siteId: z.string().describe('Site identifier'),
      header: z.record(z.unknown()).optional().describe('Header config fields to merge'),
      footer: z.record(z.unknown()).optional().describe('Footer config fields to merge'),
      topLevel: z.record(z.unknown()).optional().describe('Top-level config fields to merge (not under header/footer)'),
    },
  }, async ({ siteId, header, footer, topLevel }) => {
    try {
      const client = getClient(siteId);

      // Read current config
      const current = await client.getHeaderFooter();
      if (!current.success || !current.config) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${current.error ?? 'Failed to read current header/footer config'}` }],
          isError: true,
        };
      }

      const config = current.config as Record<string, any>;

      // Merge header updates
      if (header) {
        if (config.header && typeof config.header === 'object') {
          Object.assign(config.header, header);
        } else {
          config.header = header;
        }
      }

      // Merge footer updates
      if (footer) {
        if (config.footer && typeof config.footer === 'object') {
          Object.assign(config.footer, footer);
        } else {
          config.footer = footer;
        }
      }

      // Merge top-level fields (excluding header/footer)
      if (topLevel) {
        for (const [k, v] of Object.entries(topLevel)) {
          if (k !== 'header' && k !== 'footer') {
            config[k] = v;
          }
        }
      }

      // Write back
      const saveResult = await client.saveHeaderFooter(config);
      if (!saveResult.success) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${saveResult.error ?? 'Failed to save header/footer config'}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });
}
