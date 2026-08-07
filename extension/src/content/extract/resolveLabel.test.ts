// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildDescriptor } from './buildDescriptor';
import {
  isOpaqueFieldName,
  resolveLabel,
} from './resolveLabel';

function fromHtml(html: string, sel: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.replaceChildren(wrap);
  return wrap.querySelector(sel)!;
}

/** Minimal Lever custom-card markup (Ethena-style). */
function leverCardField(opts: {
  uuid: string;
  question: string;
  heading?: string;
  required?: boolean;
  fieldIndex?: number;
}): string {
  const field = `field${opts.fieldIndex ?? 0}`;
  const reqMark = opts.required
    ? '<span class="required">✱</span>'
    : '';
  const reqAttr = opts.required ? ' required="required"' : '';
  const heading = opts.heading
    ? `<h4 data-qa="card-name">${opts.heading}</h4>`
    : '';
  return `
    <div class="section page-centered application-form" data-qa="additional-cards">
      ${heading}
      <ul>
        <li class="application-question custom-question">
          <div>
            <div class="application-label full-width textarea">
              <div class="text">${opts.question}${reqMark}</div>
            </div>
            <div class="application-field full-width${opts.required ? ' required-field' : ''}">
              <textarea class="card-field-input" name="cards[${opts.uuid}][${field}]"${reqAttr}></textarea>
            </div>
          </div>
        </li>
      </ul>
    </div>`;
}

describe('isOpaqueFieldName', () => {
  it('flags Lever cards[uuid][fieldN] names', () => {
    expect(
      isOpaqueFieldName(
        'cards[7a73041c-8db2-4fa1-a8ce-48ef7a5efc14][field0]'
      )
    ).toBe(true);
  });

  it('flags humanized uuid-like fragments', () => {
    expect(
      isOpaqueFieldName(
        'cards[7a73041c 8db2 4fa1 a8ce 48ef7a5efc14][field0]'
      )
    ).toBe(true);
  });

  it('allows normal human name attrs', () => {
    expect(isOpaqueFieldName('first_name')).toBe(false);
    expect(isOpaqueFieldName('email')).toBe(false);
    expect(isOpaqueFieldName('urls[LinkedIn]')).toBe(false);
  });
});

describe('resolveLabel — Lever opaque cards[...]', () => {
  it('prefers visible application-label text over cards[uuid] name', () => {
    const ta = fromHtml(
      leverCardField({
        uuid: '7a73041c-8db2-4fa1-a8ce-48ef7a5efc14',
        question:
          'Please list your name pronunciation so our team can address you correctly.',
        heading: 'Name Pronunciation',
      }),
      'textarea'
    );
    const label = resolveLabel(ta);
    expect(label).toMatch(/name pronunciation/i);
    expect(label).not.toMatch(/cards\[/i);
    expect(isOpaqueFieldName(label)).toBe(false);
  });

  it('prefers the long “why join” question text, not the uuid name', () => {
    const ta = fromHtml(
      leverCardField({
        uuid: 'cc0ed195-152c-4b28-8c58-bcb448fe4083',
        question: 'Why are you interested in joining Ethena?',
        heading: "We're glad you're here!",
        required: true,
      }),
      'textarea'
    );
    expect(resolveLabel(ta)).toBe(
      'Why are you interested in joining Ethena?'
    );
  });

  it('falls back to preceding card heading when label div is empty', () => {
    const html = `
      <div class="section application-form">
        <h4 data-qa="card-name">Background Check Required</h4>
        <ul>
          <li class="application-question custom-question">
            <div>
              <div class="application-label full-width textarea"><div class="text"></div></div>
              <div class="application-field full-width">
                <textarea name="cards[9d7a5ae5-6789-4ad2-b5f1-93df10ad6d83][field0]"></textarea>
              </div>
            </div>
          </li>
        </ul>
      </div>`;
    const ta = fromHtml(html, 'textarea');
    expect(resolveLabel(ta)).toBe('Background Check Required');
  });

  it('uses aria-label when present even if name is opaque', () => {
    const ta = fromHtml(
      `<textarea name="cards[aaaabbbb-cccc-dddd-eeee-ffffffffffff][field0]" aria-label="Describe your experience"></textarea>`,
      'textarea'
    );
    expect(resolveLabel(ta)).toBe('Describe your experience');
  });

  it('uses fieldset legend when no preceding visible question text', () => {
    const ta = fromHtml(
      `<fieldset>
         <legend>Work authorization details</legend>
         <textarea name="cards[11112222-3333-4444-5555-666677778888][field0]"></textarea>
       </fieldset>`,
      'textarea'
    );
    expect(resolveLabel(ta)).toBe('Work authorization details');
  });

  it('still humanizes ordinary name attrs (first_name)', () => {
    const input = fromHtml(`<input type="text" name="first_name" />`, 'input');
    expect(resolveLabel(input)).toBe('first name');
  });

  it('reads preceding sibling label text (non-Lever opaque-adjacent pattern)', () => {
    const ta = fromHtml(
      `<div>
         <label>What motivates you to apply?</label>
         <textarea name="cards[aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee][field0]"></textarea>
       </div>`,
      'textarea'
    );
    expect(resolveLabel(ta)).toBe('What motivates you to apply?');
  });
});

describe('buildDescriptor — Lever opaque names', () => {
  it('exposes human question text on FieldDescriptor.label', () => {
    const ta = fromHtml(
      leverCardField({
        uuid: '401ba547-6b64-4c1d-a143-11ce6538a8e6',
        question:
          'How did you first hear about Ethena? If an Ethena team member brought you here, we would love to know who.',
        heading: 'How did you hear about us?',
      }),
      'textarea'
    );
    const desc = buildDescriptor({ id: 'f1', el: ta });
    expect(desc.label).toMatch(/how did you first hear about ethena/i);
    expect(desc.label).not.toMatch(/cards\[/i);
    expect(desc.widget).toBe('textarea');
  });
});
