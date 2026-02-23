import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, extname } from 'path';
import { logger } from '../utils/logger.js';

const SCREENSHOTS_DIR = join(process.cwd(), 'storage', 'screenshots');

/**
 * Serve screenshots via HTTP.
 * Useful for debugging and as a fallback when WhatsApp image upload fails.
 *
 * GET /screenshots/:filename
 */
export async function screenshotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/screenshots/:filename', async (
    request: FastifyRequest<{ Params: { filename: string } }>,
    reply: FastifyReply,
  ) => {
    const { filename } = request.params;

    // Prevent directory traversal
    if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    const filePath = resolve(SCREENSHOTS_DIR, filename);

    if (!filePath.startsWith(resolve(SCREENSHOTS_DIR))) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'Screenshot not found' });
    }

    const ext = extname(filename).toLowerCase();
    const contentType =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : 'application/octet-stream';

    const data = readFileSync(filePath);
    logger.debug({ filename }, 'Serving screenshot');

    return reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=3600')
      .send(data);
  });
}
