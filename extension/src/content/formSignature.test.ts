/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  currentFormSignature,
  debounce,
} from '../content/formSignature';

beforeEach(() => {
  // jsdom reports 0×0 boxes; production Chromium does not.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 20,
      right: 100,
      width: 100,
      height: 20,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
});

describe('currentFormSignature', () => {
  it('changes when a field is added', () => {
    document.body.innerHTML = `
      <form>
        <label>First Name <input name="first" /></label>
      </form>
    `;
    const a = currentFormSignature(document);
    expect(a.length).toBeGreaterThan(0);
    document.body.innerHTML = `
      <form>
        <label>First Name <input name="first" /></label>
        <label>Last Name <input name="last" /></label>
      </form>
    `;
    const b = currentFormSignature(document);
    expect(a).not.toBe(b);
    expect(b.split('\n').length).toBeGreaterThan(a.split('\n').length);
  });

  it('is stable for identical forms', () => {
    document.body.innerHTML = `
      <form>
        <label>Email <input type="email" name="email" /></label>
      </form>
    `;
    expect(currentFormSignature(document)).toBe(currentFormSignature(document));
  });

  it('changes when step visibility toggles via class (SPA wizard)', () => {
    document.body.innerHTML = `
      <form>
        <div class="step active" data-step="1">
          <label>First Name <input name="firstName" /></label>
        </div>
        <div class="step" data-step="2" style="display:none">
          <label>Why join? <textarea name="why"></textarea></label>
        </div>
      </form>
    `;
    // Simulate Chromium: hidden ancestors → zero box for descendants
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      let el: Element | null = this;
      while (el) {
        const style = (el as HTMLElement).style;
        const hidden =
          style?.display === 'none' ||
          (el instanceof HTMLElement &&
            el.classList.contains('step') &&
            !el.classList.contains('active'));
        if (hidden) {
          return {
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            bottom: 0,
            right: 0,
            width: 0,
            height: 0,
            toJSON() {
              return {};
            },
          } as DOMRect;
        }
        el = el.parentElement;
      }
      return orig.call(this);
    };
    const a = currentFormSignature(document);
    document.querySelector('[data-step="1"]')?.classList.remove('active');
    (document.querySelector('[data-step="1"]') as HTMLElement).style.display =
      'none';
    document.querySelector('[data-step="2"]')?.classList.add('active');
    (document.querySelector('[data-step="2"]') as HTMLElement).style.display =
      '';
    const b = currentFormSignature(document);
    Element.prototype.getBoundingClientRect = orig;
    expect(a).not.toBe(b);
    expect(b.toLowerCase()).toContain('why');
  });
});

describe('debounce', () => {
  it('fires once after quiet period', async () => {
    let n = 0;
    const fn = debounce(() => {
      n += 1;
    }, 30);
    fn();
    fn();
    fn();
    expect(n).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(1);
  });
});
