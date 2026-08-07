// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import {
  bestFuzzyMatch,
  comboboxQueryVariants,
  fillCombobox,
  findListboxFor,
} from './combobox';

describe('comboboxQueryVariants', () => {
  it('yields city before comma and first token', () => {
    expect(comboboxQueryVariants('Bengaluru, Karnataka, India')).toEqual([
      'Bengaluru, Karnataka, India',
      'Bengaluru',
    ]);
  });

  it('dedupes when value is already a single token', () => {
    expect(comboboxQueryVariants('Bengaluru')).toEqual(['Bengaluru']);
  });
});

describe('bestFuzzyMatch', () => {
  function opts(...labels: string[]): Element[] {
    return labels.map((t) => {
      const li = document.createElement('div');
      li.setAttribute('role', 'option');
      li.textContent = t;
      return li;
    });
  }

  it('matches partial city against fuller option label', () => {
    const match = bestFuzzyMatch(
      opts('Mumbai, Maharashtra, India', 'Bengaluru, Karnataka, India', 'Pune'),
      'Bengaluru'
    );
    expect(match?.textContent).toBe('Bengaluru, Karnataka, India');
  });

  it('matches exact option text', () => {
    const match = bestFuzzyMatch(opts('Yes', 'No'), 'Yes');
    expect(match?.textContent).toBe('Yes');
  });

  it('returns null when nothing is close', () => {
    expect(bestFuzzyMatch(opts('Remote', 'Hybrid'), 'Bengaluru')).toBeNull();
  });
});

describe('fillCombobox', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ignores intl-tel-input country listbox and picks ATS options', async () => {
    document.body.innerHTML = `
      <ul class="iti__country-list" role="listbox">
        <li role="option">Afghanistan +93</li>
        <li role="option">India +91</li>
      </ul>
      <div class="select__control">
        <input id="loc" role="combobox" aria-controls="loc-listbox" type="text" />
      </div>
      <div id="loc-listbox" role="listbox" hidden></div>
    `;
    const input = document.getElementById('loc')!;
    const listbox = document.getElementById('loc-listbox')!;

    // Reveal options after type (async autocomplete)
    input.addEventListener('input', () => {
      listbox.hidden = false;
      listbox.innerHTML = `
        <div role="option">Bengaluru, Karnataka, India</div>
        <div role="option">Belgaum, Karnataka, India</div>
      `;
    });

    await fillCombobox(input, 'Bengaluru');

    expect(findListboxFor(input, 'Bengaluru')?.id).toBe('loc-listbox');
    // Option was clicked — simulate selection by putting single-value
    // (driver clicks the option; we assert no throw + listbox was the right one)
  });

  it('selects via mousedown on matching option', async () => {
    document.body.innerHTML = `
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__single-value" id="sv"></div>
          <input id="c" role="combobox" type="text" />
        </div>
      </div>
      <div id="menu" role="listbox"></div>
    `;
    const input = document.getElementById('c') as HTMLInputElement;
    const menu = document.getElementById('menu')!;
    const sv = document.getElementById('sv')!;

    input.addEventListener('input', () => {
      menu.innerHTML = `
        <div role="option" id="opt-blr">Bengaluru, Karnataka, India</div>
        <div role="option">Chennai, Tamil Nadu, India</div>
      `;
      menu.querySelector('#opt-blr')!.addEventListener('mousedown', () => {
        sv.textContent = 'Bengaluru, Karnataka, India';
        input.value = '';
      });
    });

    await fillCombobox(input, 'Bengaluru');
    expect(sv.textContent).toBe('Bengaluru, Karnataka, India');
  });

  it('throws no-matching-option when options exist but none match', async () => {
    document.body.innerHTML = `
      <input id="c" role="combobox" type="text" />
      <div role="listbox">
        <div role="option">Remote</div>
        <div role="option">Hybrid</div>
      </div>
    `;
    const input = document.getElementById('c')!;
    await expect(fillCombobox(input, 'Bengaluru')).rejects.toThrow(
      'no-matching-option'
    );
  });
});
