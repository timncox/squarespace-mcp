import Fastify from 'fastify';
import { logger } from './utils/logger.js';
import { healthRoutes } from './routes/health.js';
import { screenshotRoutes } from './routes/screenshots.js';
import { whatsappWebhookRoutes } from './routes/whatsapp-webhook.js';
import { dashboardRoutes } from './routes/dashboard.js';

/** Routes exempt from bearer token auth (public endpoints). */
const PUBLIC_PREFIXES = ['/health', '/webhook'];

export async function createServer() {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // ── Dashboard Auth Middleware ────────────────────────────────────────────
  // Protect dashboard + screenshots behind a bearer token (set DASHBOARD_TOKEN in .env).
  // Health and webhook routes are exempt — webhooks have their own verification.
  const dashboardToken = process.env.DASHBOARD_TOKEN;
  if (dashboardToken) {
    app.addHook('onRequest', async (request, reply) => {
      // Skip auth for public routes
      if (PUBLIC_PREFIXES.some((p) => request.url.startsWith(p))) return;

      const authHeader = request.headers.authorization;
      // Accept "Bearer <token>" header OR "?token=<token>" query param (for SSE/browser)
      const queryToken = (request.query as Record<string, string>)?.token;
      const provided = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : queryToken;

      if (provided !== dashboardToken) {
        logger.warn({ url: request.url, ip: request.ip }, 'Dashboard auth: rejected request');
        return reply.status(401).send({ error: 'Unauthorized — set Authorization: Bearer <DASHBOARD_TOKEN>' });
      }
    });
    logger.info('Dashboard authentication enabled (DASHBOARD_TOKEN set)');
  } else {
    logger.warn('DASHBOARD_TOKEN not set — dashboard is UNPROTECTED. Set it in .env for production.');
  }

  // Register routes
  await app.register(healthRoutes);
  await app.register(screenshotRoutes);
  await app.register(whatsappWebhookRoutes);
  await app.register(dashboardRoutes);

  return app;
}

export async function startServer(): Promise<ReturnType<typeof createServer>> {
  const port = parseInt(process.env.PORT ?? '3000', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  const app = await createServer();

  try {
    await app.listen({ port, host });
    logger.info({ port, host }, 'Server listening');
    console.log(`\n🚀 Server running at http://${host}:${port}`);
    console.log(`   Health:    http://localhost:${port}/health`);
    console.log(`   Webhook:   http://localhost:${port}/webhook`);
    console.log(`   Dashboard: http://localhost:${port}/dashboard`);
    console.log(`\n   Use ngrok to expose: ngrok http ${port}\n`);
  } catch (err) {
    logger.error({ error: err }, 'Failed to start server');
    throw err;
  }

  return app;
}
