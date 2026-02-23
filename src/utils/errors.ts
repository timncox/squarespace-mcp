/**
 * Error handling utilities.
 *
 * Replaces the 47+ instances of `err instanceof Error ? err.message : String(err)`
 * scattered across the codebase with a single import.
 */

/**
 * Safely extract an error message from an unknown caught value.
 *
 * Usage:
 * ```ts
 * } catch (err) {
 *   logger.error({ error: errMsg(err) }, 'Something failed');
 * }
 * ```
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract error context including stack trace for structured logging.
 * Use for important errors where the stack trace aids debugging.
 *
 * Usage:
 * ```ts
 * } catch (err) {
 *   logger.error(errContext(err), 'Critical operation failed');
 * }
 * ```
 *
 * Returns `{ error: string, stack?: string, code?: string }` — pino
 * serializes this into structured JSON for easy grep/filtering.
 */
export function errContext(err: unknown): { error: string; stack?: string; code?: string } {
  if (err instanceof Error) {
    return {
      error: err.message,
      stack: err.stack,
      code: (err as NodeJS.ErrnoException).code,
    };
  }
  return { error: String(err) };
}
