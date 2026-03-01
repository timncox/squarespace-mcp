import pino from 'pino';

export const logger = pino({
  transport: {
    target: 'pino/file',
    options: { destination: 2 }, // stderr — keeps stdout clean for CLI data output
  },
  level: process.env.LOG_LEVEL ?? 'info',
});
