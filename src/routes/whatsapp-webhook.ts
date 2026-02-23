import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger.js';
import { parseWebhookPayload } from '../services/whatsapp.js';
import { messageExists } from '../db/whatsapp-messages.js';
import { handleIncomingMessage } from '../services/conversation-handler.js';

/**
 * WhatsApp Business Cloud API webhook routes.
 *
 * GET  /webhook  — Meta verification challenge (used when registering the webhook URL)
 * POST /webhook  — Incoming messages and status updates
 */
export async function whatsappWebhookRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Webhook verification.
   * Meta sends a GET request with a challenge token when you register the webhook.
   * We must verify the token matches our WHATSAPP_VERIFY_TOKEN and echo back the challenge.
   */
  app.get('/webhook', async (
    request: FastifyRequest<{
      Querystring: {
        'hub.mode'?: string;
        'hub.verify_token'?: string;
        'hub.challenge'?: string;
      };
    }>,
    reply: FastifyReply,
  ) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!verifyToken) {
      logger.error('WHATSAPP_VERIFY_TOKEN not set');
      return reply.status(500).send('Server misconfigured');
    }

    if (mode === 'subscribe' && token === verifyToken) {
      logger.info('Webhook verified successfully');
      return reply.status(200).send(challenge);
    }

    logger.warn({ mode, token }, 'Webhook verification failed');
    return reply.status(403).send('Forbidden');
  });

  /**
   * Incoming webhook — handles messages and status updates from WhatsApp.
   *
   * Meta expects a 200 response quickly, so we process messages asynchronously.
   */
  app.post('/webhook', async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // Always respond 200 immediately — Meta retries on non-200
    reply.status(200).send('EVENT_RECEIVED');

    try {
      const messages = parseWebhookPayload(request.body);

      if (messages.length === 0) {
        // Likely a status update (delivered, read, etc.) — ignore
        return;
      }

      const timNumber = process.env.TIM_WHATSAPP_NUMBER;

      for (const msg of messages) {
        // Only process messages from Tim
        if (timNumber && msg.from !== timNumber) {
          logger.warn({ from: msg.from }, 'Ignoring message from unknown number');
          continue;
        }

        // Dedup — skip if we've already processed this message
        if (messageExists(msg.waMessageId)) {
          logger.debug({ waMessageId: msg.waMessageId }, 'Duplicate message, skipping');
          continue;
        }

        // Process the message
        await handleIncomingMessage(msg);
      }
    } catch (err) {
      logger.error({ error: err }, 'Error processing webhook payload');
    }
  });
}
