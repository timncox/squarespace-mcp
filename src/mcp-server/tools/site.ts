/**
 * MCP Tools — Site-wide settings
 *
 * sq_get_settings: Read site settings
 * sq_update_settings: Write site settings (partial update)
 * sq_get_design: Read fonts + colors + tweaks
 * sq_update_design: Update fonts, colors, and/or tweaks
 * sq_get_code_injection: Read header/footer code injection
 * sq_update_code_injection: Save header/footer scripts
 * sq_update_css: Update custom CSS
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getClient } from '../session.js';

export function registerSiteTools(server: McpServer) {
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
        const fontResult = await client.updateFont(font.fontName, font.updates);
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
}
