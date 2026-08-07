// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readComboboxLabel } from './comboboxValue';

function control(html: string): HTMLInputElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.replaceChildren(wrap);
  return wrap.querySelector('input[role="combobox"]')!;
}

describe('readComboboxLabel (react-select style)', () => {
  it('reads the selected label from the sibling single-value node (input is empty)', () => {
    const input = control(`
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__single-value">Male</div>
          <div class="select__input-container">
            <input role="combobox" value="" />
          </div>
        </div>
      </div>`);
    expect(input.value).toBe(''); // react-select keeps the input empty
    expect(readComboboxLabel(input)).toBe('Male');
  });

  it('returns empty for the placeholder state', () => {
    const input = control(`
      <div class="select__control">
        <div class="select__value-container">
          <div class="select__placeholder">Select...</div>
          <input role="combobox" value="" />
        </div>
      </div>`);
    expect(readComboboxLabel(input)).toBe('');
  });

  it('handles emotion-hashed singleValue class names', () => {
    const input = control(`
      <div class="css-1abc-control">
        <div class="css-1xyz-singleValue">Asian</div>
        <input role="combobox" value="" />
      </div>`);
    expect(readComboboxLabel(input)).toBe('Asian');
  });

  it('prefers a direct aria-valuetext when present', () => {
    const input = control(`
      <div class="select__control">
        <input role="combobox" aria-valuetext="Yes" value="" />
      </div>`);
    expect(readComboboxLabel(input)).toBe('Yes');
  });
});
