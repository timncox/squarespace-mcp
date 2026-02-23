import { logger } from './logger.js';

interface RetryOptions {
  maxRetries: number;
  delayMs: number;
  backoffMultiplier?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, delayMs, backoffMultiplier = 2, onRetry } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const wait = delayMs * Math.pow(backoffMultiplier, attempt);
        logger.warn({ attempt: attempt + 1, maxRetries, waitMs: wait, error: lastError.message }, 'Retrying after error');
        onRetry?.(lastError, attempt + 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  throw lastError;
}
