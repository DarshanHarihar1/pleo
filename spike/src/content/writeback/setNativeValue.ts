/**
 * Reach past framework value trackers (React) to the browser's native
 * setter, then fire the events frameworks listen for. (HLD §7.2)
 *
 * Input and textarea have DIFFERENT prototypes — wrong one throws.
 */
export function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string
): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fillNativeSelect(el: HTMLSelectElement, value: string): void {
  const normalized = value.trim().toLowerCase();
  let matched: HTMLOptionElement | null = null;

  for (const opt of Array.from(el.options)) {
    const text = (opt.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (
      opt.value === value ||
      text === value ||
      text.toLowerCase() === normalized ||
      opt.value.toLowerCase() === normalized
    ) {
      matched = opt;
      break;
    }
  }

  if (!matched) {
    // partial contains match
    for (const opt of Array.from(el.options)) {
      const text = (opt.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text.includes(normalized) || normalized.includes(text)) {
        matched = opt;
        break;
      }
    }
  }

  if (!matched) {
    throw new Error(`no-matching-option:${value}`);
  }

  el.value = matched.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fillRadioGroup(
  groupEls: HTMLInputElement[],
  value: string
): void {
  const normalized = value.trim().toLowerCase();
  const match = groupEls.find((r) => {
    if (r.value.toLowerCase() === normalized) return true;
    if ((r.value || '').trim() === value) return true;
    // label text near the radio
    const id = r.id;
    if (id) {
      const root = r.getRootNode() as Document | ShadowRoot;
      const lab = root.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab) {
        const t = (lab.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (t === normalized || t.includes(normalized)) return true;
      }
    }
    const wrap = r.closest('label');
    if (wrap) {
      const t = (wrap.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (t === normalized || t.includes(normalized)) return true;
    }
    return false;
  });

  if (!match) {
    throw new Error(`no-matching-radio:${value}`);
  }
  if (!match.checked) {
    match.click();
  }
}

export function fillCheckbox(el: HTMLInputElement, checked: boolean): void {
  if (el.checked !== checked) {
    el.click();
  }
}

export function fillContentEditable(el: HTMLElement, value: string): void {
  el.focus();
  el.textContent = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
