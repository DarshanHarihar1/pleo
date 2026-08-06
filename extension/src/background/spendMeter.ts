/**
 * HLD §9.5 — spend circuit breaker + cost meter.
 * Token prices are approximate list rates for budgeting (BYOK actual bill may differ).
 */

import type {
  BudgetSettings,
  ProviderName,
  SpendSnapshot,
  TokenUsage,
} from '../shared/types';

const SPEND_KEY = 'spend_meter';

/** USD per 1M tokens — rough list prices for circuit-breaker accounting */
const RATES: Record<
  ProviderName,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  anthropic: {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  openai: {
    input: 2.5,
    output: 10,
    cacheRead: 1.25,
    cacheWrite: 2.5,
  },
  groq: {
    input: 0.59,
    output: 0.79,
    cacheRead: 0.59,
    cacheWrite: 0.59,
  },
};

type DayRecord = {
  dayKey: string;
  calls: number;
  spendUSD: number;
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function estimateCostUSD(
  provider: ProviderName,
  usage: TokenUsage
): number {
  const r = RATES[provider];
  const cost =
    (usage.input * r.input +
      usage.output * r.output +
      usage.cacheRead * r.cacheRead +
      usage.cacheWrite * r.cacheWrite) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export class SpendMeter {
  private day: DayRecord = { dayKey: todayKey(), calls: 0, spendUSD: 0 };
  private pageCalls = new Map<number, number>();
  private pageSpend = new Map<number, number>();
  private lastUsage: TokenUsage | null = null;
  private loaded = false;

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      this.rollDay();
      return;
    }
    const stored = await chrome.storage.local.get(SPEND_KEY);
    const raw = stored[SPEND_KEY] as DayRecord | undefined;
    if (raw && typeof raw.dayKey === 'string') {
      this.day = {
        dayKey: raw.dayKey,
        calls: Number(raw.calls) || 0,
        spendUSD: Number(raw.spendUSD) || 0,
      };
    }
    this.rollDay();
    this.loaded = true;
  }

  private rollDay(): void {
    const k = todayKey();
    if (this.day.dayKey !== k) {
      this.day = { dayKey: k, calls: 0, spendUSD: 0 };
    }
  }

  resetPage(tabId: number): void {
    this.pageCalls.set(tabId, 0);
    this.pageSpend.set(tabId, 0);
  }

  removeTab(tabId: number): void {
    this.pageCalls.delete(tabId);
    this.pageSpend.delete(tabId);
  }

  /**
   * Returns null if allowed, or a human-readable block reason.
   * T-1 still applies when blocked — caller skips only T2.
   */
  async checkAllowed(
    tabId: number,
    budget: BudgetSettings
  ): Promise<string | null> {
    await this.ensureLoaded();
    const pageCalls = this.pageCalls.get(tabId) ?? 0;
    if (pageCalls >= budget.maxCallsPerPage) {
      return `Page LLM call limit reached (${budget.maxCallsPerPage}).`;
    }
    if (this.day.calls >= budget.maxCallsPerDay) {
      return `Daily LLM call limit reached (${budget.maxCallsPerDay}).`;
    }
    if (this.day.spendUSD >= budget.maxSpendPerDayUSD) {
      return `Daily spend limit reached ($${budget.maxSpendPerDayUSD.toFixed(2)}).`;
    }
    return null;
  }

  async recordCall(
    tabId: number,
    provider: ProviderName,
    usage: TokenUsage
  ): Promise<number> {
    await this.ensureLoaded();
    const cost = estimateCostUSD(provider, usage);
    this.day.calls += 1;
    this.day.spendUSD = Math.round((this.day.spendUSD + cost) * 1_000_000) / 1_000_000;
    this.pageCalls.set(tabId, (this.pageCalls.get(tabId) ?? 0) + 1);
    this.pageSpend.set(
      tabId,
      Math.round(((this.pageSpend.get(tabId) ?? 0) + cost) * 1_000_000) / 1_000_000
    );
    this.lastUsage = usage;
    await chrome.storage.local.set({ [SPEND_KEY]: this.day });
    return cost;
  }

  async snapshot(
    tabId: number,
    budget: BudgetSettings
  ): Promise<SpendSnapshot> {
    await this.ensureLoaded();
    const blockReason = await this.checkAllowed(tabId, budget);
    return {
      dayKey: this.day.dayKey,
      callsToday: this.day.calls,
      spendTodayUSD: this.day.spendUSD,
      callsThisPage: this.pageCalls.get(tabId) ?? 0,
      pageSpendUSD: this.pageSpend.get(tabId) ?? 0,
      lastUsage: this.lastUsage,
      blocked: blockReason != null,
      blockReason,
    };
  }
}
