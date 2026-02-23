/**
 * Centralized model configuration.
 *
 * Change model IDs here to update them across the entire codebase.
 * Every agent, service, and script imports from this file.
 */

/** Primary model — used for complex reasoning, content strategy, browser agent */
export const MODEL_SONNET = 'claude-sonnet-4-20250514';

/** Fast/cheap model — used for research synthesis, doc distillation, quick verification */
export const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
