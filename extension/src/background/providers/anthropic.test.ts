import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { anthropicProvider } from './anthropic';

function baseArgs() {
  return {
    apiKey: 'test-key',
    model: 'claude-test',
    systemBlock: 'system',
    fields: [],
    jdSummary: null,
    memoryCandidates: [],
    schema: {},
  };
}

describe('anthropicProvider.resolve timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a hung fetch instead of blocking forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      })
    );

    const pending = anthropicProvider.resolve(baseArgs());
    // Attach a rejection handler before the promise settles so
    // advancing fake timers doesn't produce an unhandled rejection.
    const expectation = expect(pending).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });
});
