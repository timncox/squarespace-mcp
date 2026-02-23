/**
 * Conversation model — tracks the WhatsApp interaction between the agent and Tim.
 *
 * State machine:
 *   idle → awaiting_confirm → executing → completed
 *                           → rejected
 *                           → clarifying → awaiting_confirm
 *                           → planning → awaiting_plan_approval → executing
 *                                                                → revising → awaiting_plan_approval
 *                                                                → rejected
 *
 * Sources:
 *   - 'email': triggered by forwarded email → task extraction
 *   - 'whatsapp': triggered by direct WhatsApp message from Tim
 */

export type ConversationStatus =
  | 'awaiting_confirm'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'clarifying'
  | 'planning'                // Content pipeline running (research + analysis + drafting)
  | 'awaiting_plan_approval'  // Content plan sent to Tim, waiting for approval or feedback
  | 'revising';               // Tim gave feedback, re-running content strategist

export type ConversationSource = 'email' | 'whatsapp' | 'dashboard';

export interface Conversation {
  id: string;
  /** Email ID if triggered by email; undefined for WhatsApp-originated requests */
  emailId?: string;
  /** How this conversation was initiated */
  source: ConversationSource;
  status: ConversationStatus;
  /** Task IDs associated with this conversation (JSON array in DB) */
  taskIds: string[];
  /** Summary sent to Tim */
  summaryText: string;
  /** JSON-serialized ContentPlan from the content strategist agent */
  contentPlan?: string;
  /** Tim's most recent feedback on the content plan (used for revisions) */
  planFeedback?: string;
  /** Original user message text (before LLM rewriting) — used for planning detection */
  originalMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type WhatsAppDirection = 'inbound' | 'outbound';

export interface WhatsAppMessage {
  id: string;
  conversationId?: string;
  waMessageId?: string;
  direction: WhatsAppDirection;
  fromNumber: string;
  toNumber: string;
  body: string;
  /** For image messages — the media ID or local path */
  mediaUrl?: string;
  timestamp: string;
  createdAt: string;
}
