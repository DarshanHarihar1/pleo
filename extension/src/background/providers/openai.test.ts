import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openaiProvider } from './openai';

function baseArgs() {
  return {
    apiKey: 'test-key',
    model: 'gpt-test',
    systemBlock: 'system',
    fields: [],
    jdSummary: null,
    memoryCandidates: [],
    schema: {},
  };
}

describe('openaiProvider.resolve timeout', () => {
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

    const pending = openaiProvider.resolve(baseArgs());
    const expectation = expect(pending).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(30_000);

    await expectation;
  });
});
