// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { classifyWidget } from './classifyWidget';

function fromHtml(html: string, sel: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.replaceChildren(wrap);
  return wrap.querySelector(sel)!;
}

describe('classifyWidget — react-select inputs', () => {
  it('classifies a text <input role="combobox"> as custom-combobox (not text)', () => {
    const input = fromHtml(
      `<div class="select__control">
         <div class="select__value-container">
           <input class="select__input" role="combobox" type="text" />
         </div>
       </div>`,
      'input'
    );
    expect(classifyWidget(input)).toBe('custom-combobox');
  });

  it('classifies a multi react-select input as chip-input', () => {
    const input = fromHtml(
      `<div class="select__control">
         <div class="select__value-container">
           <div class="select__multi-value">React</div>
           <input class="select__input" role="combobox" type="text" />
         </div>
       </div>`,
      'input'
    );
    expect(classifyWidget(input)).toBe('chip-input');
  });

  it('still classifies a plain text input as text', () => {
    const input = fromHtml(`<input type="text" />`, 'input');
    expect(classifyWidget(input)).toBe('text');
  });
});
