// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { probeIframes } from './iframeProbe';
import {
  buildIframeLimitationHint,
  decideIframeLimitationHint,
  hostFromIframeSrc,
  isLikelyFormHost,
  type IframeProbeSnapshot,
} from '../../shared/iframeHint';

describe('isLikelyFormHost', () => {
  it('matches Airtable / Greenhouse / Lever embeds', () => {
    expect(isLikelyFormHost('airtable.com')).toBe(true);
    expect(isLikelyFormHost('www.airtable.com')).toBe(true);
    expect(isLikelyFormHost('job-boards.greenhouse.io')).toBe(true);
    expect(isLikelyFormHost('jobs.lever.co')).toBe(true);
    expect(isLikelyFormHost('jobs.ashbyhq.com')).toBe(true);
  });

  it('rejects unrelated hosts', () => {
    expect(isLikelyFormHost('cdn.example.com')).toBe(false);
    expect(isLikelyFormHost('youtube.com')).toBe(false);
    expect(isLikelyFormHost('')).toBe(false);
  });
});

describe('hostFromIframeSrc', () => {
  it('parses absolute and relative srcs', () => {
    expect(
      hostFromIframeSrc(
        'https://airtable.com/embed/appX',
        'https://lamatic.ai/careers'
      )
    ).toBe('airtable.com');
    expect(
      hostFromIframeSrc('//job-boards.greenhouse.io/x', 'https://corp.com/')
    ).toBe('job-boards.greenhouse.io');
  });

  it('skips blank / non-http', () => {
    expect(hostFromIframeSrc('about:blank')).toBeNull();
    expect(hostFromIframeSrc('')).toBeNull();
    expect(hostFromIframeSrc('javascript:void(0)')).toBeNull();
  });
});

describe('probeIframes', () => {
  it('counts cross-origin iframes and collects likely form hosts', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const a = doc.createElement('iframe');
    a.setAttribute('src', 'https://airtable.com/embed/app1');
    Object.defineProperty(a, 'contentDocument', {
      get() {
        return null;
      },
    });
    doc.body.appendChild(a);

    const b = doc.createElement('iframe');
    b.setAttribute('src', 'https://cdn.example.com/widget');
    Object.defineProperty(b, 'contentDocument', {
      get() {
        return null;
      },
    });
    doc.body.appendChild(b);

    const snap = probeIframes(doc, 'https://lamatic.ai/company/career');
    expect(snap.crossOriginCount).toBe(2);
    expect(snap.sameOriginCount).toBe(0);
    expect(snap.crossOriginHosts).toEqual([
      'airtable.com',
      'cdn.example.com',
    ]);
    expect(snap.likelyFormHosts).toEqual(['airtable.com']);
  });

  it('counts same-origin when contentDocument is readable', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const frame = doc.createElement('iframe');
    frame.setAttribute('src', '/local-form.html');
    // jsdom leaves contentDocument null unless mocked — same-origin means readable
    Object.defineProperty(frame, 'contentDocument', {
      get() {
        return doc;
      },
    });
    doc.body.appendChild(frame);
    const snap = probeIframes(doc, 'https://corp.example/jobs');
    expect(snap.sameOriginCount).toBe(1);
    expect(snap.crossOriginCount).toBe(0);
  });
});

describe('decideIframeLimitationHint', () => {
  const airtableProbe: IframeProbeSnapshot = {
    sameOriginCount: 0,
    crossOriginCount: 1,
    crossOriginHosts: ['airtable.com'],
    likelyFormHosts: ['airtable.com'],
  };

  it('warns when likely form embed exists but no file fields (Lamatic case)', () => {
    const hint = decideIframeLimitationHint({
      probe: airtableProbe,
      fieldFrameIds: [0],
      fileFieldCount: 0,
      totalFieldCount: 19,
    });
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('no-file-fields');
    expect(hint!.hosts).toEqual(['airtable.com']);
    expect(hint!.message).toMatch(/airtable\.com/i);
    expect(hint!.detail).toMatch(/will not fake an attach/i);
  });

  it('does not warn when child frames contributed file fields', () => {
    const hint = decideIframeLimitationHint({
      probe: airtableProbe,
      fieldFrameIds: [0, 6],
      fileFieldCount: 1,
      totalFieldCount: 20,
    });
    expect(hint).toBeNull();
  });

  it('stays quiet on empty scan with only tracking/CDN iframes', () => {
    const hint = decideIframeLimitationHint({
      probe: {
        sameOriginCount: 0,
        crossOriginCount: 1,
        crossOriginHosts: ['random-cdn.net'],
        likelyFormHosts: [],
      },
      fieldFrameIds: [],
      fileFieldCount: 0,
      totalFieldCount: 0,
    });
    expect(hint).toBeNull();
  });

  it('warns on empty scan when a likely form host is embedded', () => {
    const hint = decideIframeLimitationHint({
      probe: airtableProbe,
      fieldFrameIds: [],
      fileFieldCount: 0,
      totalFieldCount: 0,
    });
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('no-fields');
    expect(hint!.hosts).toEqual(['airtable.com']);
  });

  it('stays quiet on marketing embeds when top-frame fields exist', () => {
    const hint = decideIframeLimitationHint({
      probe: {
        sameOriginCount: 0,
        crossOriginCount: 1,
        crossOriginHosts: ['youtube.com'],
        likelyFormHosts: [],
      },
      fieldFrameIds: [0],
      fileFieldCount: 0,
      totalFieldCount: 5,
    });
    expect(hint).toBeNull();
  });

  it('returns null when no cross-origin iframes', () => {
    expect(
      decideIframeLimitationHint({
        probe: {
          sameOriginCount: 1,
          crossOriginCount: 0,
          crossOriginHosts: [],
          likelyFormHosts: [],
        },
        fieldFrameIds: [0],
        fileFieldCount: 0,
        totalFieldCount: 3,
      })
    ).toBeNull();
  });
});

describe('buildIframeLimitationHint', () => {
  it('mentions open-in-tab guidance', () => {
    const h = buildIframeLimitationHint(['airtable.com'], 'no-file-fields');
    expect(h.detail).toMatch(/top-level tab/i);
  });
});
