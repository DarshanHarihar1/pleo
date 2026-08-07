// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { fillField } from './fillField';
import {
  compensationValuesMatch,
  normalizeCompensationValue,
  valueForCompensationInput,
} from './salaryValue';

describe('normalizeCompensationValue', () => {
  it('expands LPA to absolute INR', () => {
    expect(normalizeCompensationValue('32 LPA')).toBe('3200000');
    expect(normalizeCompensationValue('24 lakhs')).toBe('2400000');
    expect(normalizeCompensationValue('₹25 LPA')).toBe('2500000');
  });

  it('strips currency symbols and codes', () => {
    expect(
      normalizeCompensationValue('₹ 12,00,000', { forceNumeric: true })
    ).toBe('1200000');
    expect(
      normalizeCompensationValue('INR 500000', { forceNumeric: true })
    ).toBe('500000');
    expect(
      normalizeCompensationValue('$120,000', { forceNumeric: true })
    ).toBe('120000');
  });

  it('converts LPA to monthly when asked', () => {
    expect(
      normalizeCompensationValue('32 LPA', { monthly: true })
    ).toBe('266667');
  });

  it('does not expand bare small numbers without expandBareLakh', () => {
    expect(
      normalizeCompensationValue('30', { forceNumeric: true })
    ).toBe('30');
  });

  it('expands bare LPA-sized numbers only with expandBareLakh', () => {
    expect(
      normalizeCompensationValue('32', {
        forceNumeric: true,
        expandBareLakh: true,
      })
    ).toBe('3200000');
  });
});

describe('compensationValuesMatch', () => {
  it('equates LPA profile strings with digit amounts', () => {
    expect(compensationValuesMatch('32 LPA', '3200000')).toBe(true);
    expect(compensationValuesMatch('₹24,00,000', '24 LPA')).toBe(true);
  });
});

describe('valueForCompensationInput + fillField', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('writes absolute digits into Keka-style annual salary text inputs', async () => {
    document.body.innerHTML = `
      <label for="currentSalary">Current Salary</label>
      <input type="text" id="currentSalary" name="currentSalary.amount" />
    `;
    const el = document.getElementById('currentSalary') as HTMLInputElement;
    expect(valueForCompensationInput(el, '24 LPA')).toBe('2400000');

    const result = await fillField(el, '24 LPA', 'text', {
      fieldId: 'f1',
    });
    expect(result.ok).toBe(true);
    expect(el.value).toBe('2400000');
  });

  it('writes monthly amount for Desired Monthly Salary', async () => {
    document.body.innerHTML = `
      <label for="dms">Desired Monthly Salary</label>
      <input type="text" id="dms" name="desiredMonthlySalary" />
    `;
    const el = document.getElementById('dms') as HTMLInputElement;
    expect(valueForCompensationInput(el, '32 LPA')).toBe('266667');

    const result = await fillField(el, '32 LPA', 'text', { fieldId: 'f2' });
    expect(result.ok).toBe(true);
    expect(el.value).toBe('266667');
  });

  it('strips non-numeric for type=number while leaving notice-like values alone', async () => {
    document.body.innerHTML = `
      <label for="availability">Notice Period (days)</label>
      <input type="number" id="availability" name="availability" />
    `;
    const el = document.getElementById('availability') as HTMLInputElement;
    // Not a compensation field — "30 days" → forceNumeric strips to 30, no ×1e5
    expect(valueForCompensationInput(el, '30 days')).toBe('30');

    const result = await fillField(el, '30 days', 'text', { fieldId: 'f3' });
    expect(result.ok).toBe(true);
    expect(el.value).toBe('30');
  });

  it('expands LPA even on type=number salary fields', async () => {
    document.body.innerHTML = `
      <label for="ctc">Expected CTC</label>
      <input type="number" id="ctc" name="expectedCtc" />
    `;
    const el = document.getElementById('ctc') as HTMLInputElement;
    const result = await fillField(el, '32 LPA', 'text', { fieldId: 'f4' });
    expect(result.ok).toBe(true);
    expect(el.value).toBe('3200000');
  });
});
