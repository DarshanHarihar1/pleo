/**
 * Trusted side-panel ↔ service-worker channel.
 * chrome.runtime.sendMessage is delivered to every content script; API keys and
 * the full profile must never take that path (HLD §10.1).
 */

export const PANEL_PORT_NAME = 'pleo-panel';

export type PanelPortEnvelope = {
  id: number;
  message: unknown;
};

export type PanelPortResponse = {
  id: number;
  response?: unknown;
  error?: string;
};

/** Messages that must travel only on the panel port (never runtime broadcast). */
export const PORT_ONLY_TYPES = new Set([
  'SET_API_KEY',
  'UNLOCK_SESSION',
  'LOCK_SESSION',
  'SAVE_PROFILE',
  'SAVE_RESUME',
  'DELETE_RESUME',
]);
