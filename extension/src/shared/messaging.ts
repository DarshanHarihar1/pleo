import {
  PANEL_PORT_NAME,
  PORT_ONLY_TYPES,
  type PanelPortEnvelope,
  type PanelPortResponse,
} from './panelPort';

export function isMessage<T extends { type: string }>(
  msg: unknown,
  type: T['type']
): msg is T {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === type
  );
}

export function sendRuntimeMessage<T = unknown>(message: unknown): Promise<T> {
  const type =
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { type?: unknown }).type === 'string'
      ? (message as { type: string }).type
      : null;
  if (type && PORT_ONLY_TYPES.has(type)) {
    return sendPanelPortMessage<T>(message);
  }
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

let panelPort: chrome.runtime.Port | null = null;
let panelPortSeq = 0;
const panelPortPending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function ensurePanelPort(): chrome.runtime.Port {
  if (panelPort) return panelPort;
  panelPort = chrome.runtime.connect({ name: PANEL_PORT_NAME });
  panelPort.onMessage.addListener((msg: PanelPortResponse) => {
    const pending = panelPortPending.get(msg.id);
    if (!pending) return;
    panelPortPending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.response);
  });
  panelPort.onDisconnect.addListener(() => {
    panelPort = null;
    for (const [, p] of panelPortPending) {
      p.reject(new Error('Panel port disconnected'));
    }
    panelPortPending.clear();
  });
  return panelPort;
}

/** Side-panel only — Port does not fan out to content scripts. */
export function sendPanelPortMessage<T = unknown>(
  message: unknown
): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const port = ensurePanelPort();
      const id = ++panelPortSeq;
      panelPortPending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      const envelope: PanelPortEnvelope = { id, message };
      port.postMessage(envelope);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
