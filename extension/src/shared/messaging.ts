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
  return chrome.runtime.sendMessage(message) as Promise<T>;
}
