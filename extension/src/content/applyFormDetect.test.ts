/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  collectPageFormHints,
  discoverApplyLinks,
  looksLikeJobListingPage,
} from '../content/applyFormDetect';

beforeEach(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 24,
      right: 120,
      width: 120,
      height: 24,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
});

describe('discoverApplyLinks', () => {
  it('finds Apply and Submit Application anchors', () => {
    document.body.innerHTML = `
      <main>
        <h1>Software Engineer</h1>
        <a href="/jobs/123">Back to jobs</a>
        <a href="https://boards.greenhouse.io/acme/jobs/99#app">Apply</a>
        <a href="/apply-now">Submit Application</a>
      </main>
    `;
    const links = discoverApplyLinks(document);
    expect(links.map((l) => l.text)).toEqual(
      expect.arrayContaining(['Apply', 'Submit Application'])
    );
    expect(links.every((l) => l.href.includes('http'))).toBe(true);
  });

  it('ignores non-apply navigation links', () => {
    document.body.innerHTML = `
      <nav>
        <a href="/careers">Careers</a>
        <a href="/about">About us</a>
      </nav>
    `;
    expect(discoverApplyLinks(document)).toEqual([]);
  });
});

describe('looksLikeJobListingPage', () => {
  it('scores a job description page with Apply CTA as listing', () => {
    document.body.innerHTML = `
      <main>
        <h1>Staff Engineer</h1>
        <h2>About the role</h2>
        <div class="job-description">${'We build payments infrastructure. '.repeat(40)}</div>
        <a href="/apply">Apply now</a>
      </main>
    `;
    // jsdom location is about:blank — pass careers-like href
    expect(
      looksLikeJobListingPage(document, {
        href: 'https://example.com/careers/jobs/staff-engineer',
      })
    ).toBe(true);
  });

  it('does not flag a dense application form as listing', () => {
    document.body.innerHTML = `
      <form id="application_form">
        <label>First Name <input name="first_name" /></label>
        <label>Last Name <input name="last_name" /></label>
        <label>Email <input type="email" name="email" /></label>
        <label>Phone <input name="phone" /></label>
        <label>Resume <input type="file" name="resume" /></label>
        <label>Cover letter <textarea name="cover"></textarea></label>
        <button type="submit">Submit application</button>
      </form>
    `;
    expect(
      looksLikeJobListingPage(document, {
        href: 'https://boards.greenhouse.io/acme/jobs/1',
        applyLinks: [],
      })
    ).toBe(false);
  });
});

describe('collectPageFormHints', () => {
  it('returns apply links + listing flag together', () => {
    document.body.innerHTML = `
      <h2>Job description</h2>
      <div class="job-description">${'Role details go here. '.repeat(50)}</div>
      <a href="https://boards.greenhouse.io/x/jobs/1/application">Apply</a>
    `;
    const hints = collectPageFormHints(document);
    expect(hints.applyLinks.length).toBeGreaterThan(0);
    expect(hints.looksLikeListing).toBe(true);
  });
});
