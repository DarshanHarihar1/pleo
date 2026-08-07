import type { Profile } from '../shared/types';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function field(
  labelText: string,
  input: HTMLInputElement | HTMLTextAreaElement
): HTMLLabelElement {
  const wrap = el('label', 'profile-field');
  const span = el('span');
  span.textContent = labelText;
  wrap.append(span, input);
  return wrap;
}

function textInput(value: string, name: string): HTMLInputElement {
  const input = el('input');
  input.type = 'text';
  input.name = name;
  input.value = value;
  return input;
}

function textarea(
  value: string,
  name: string,
  rows = 3
): HTMLTextAreaElement {
  const ta = el('textarea');
  ta.name = name;
  ta.rows = rows;
  ta.value = value;
  return ta;
}

export interface ProfileEditorHandle {
  root: HTMLElement;
  read(): Profile;
  write(profile: Profile): void;
}

export function createProfileEditor(
  initial: Profile,
  onSave: (profile: Profile) => void
): ProfileEditorHandle {
  const root = el('div', 'profile-editor');
  let profile = structuredClone(initial);

  const identity = el('fieldset');
  const legend = el('legend');
  legend.textContent = 'Identity';
  identity.append(legend);

  const firstName = textInput(profile.identity.firstName, 'firstName');
  const lastName = textInput(profile.identity.lastName, 'lastName');
  const email = textInput(profile.identity.email, 'email');
  const phone = textInput(profile.identity.phone, 'phone');
  const city = textInput(profile.identity.location.city, 'city');
  const state = textInput(profile.identity.location.state, 'state');
  const country = textInput(profile.identity.location.country, 'country');
  const linkedin = textInput(profile.identity.links.linkedin, 'linkedin');
  const github = textInput(profile.identity.links.github, 'github');
  const portfolio = textInput(profile.identity.links.portfolio, 'portfolio');

  identity.append(
    field('First name', firstName),
    field('Last name', lastName),
    field('Email', email),
    field('Phone', phone),
    field('City', city),
    field('State', state),
    field('Country', country),
    field('LinkedIn', linkedin),
    field('GitHub', github),
    field('Portfolio', portfolio)
  );

  const declarations = el('fieldset');
  const dLegend = el('legend');
  dLegend.textContent = 'Declarations';
  declarations.append(dLegend);
  const noticePeriod = textInput(
    profile.declarations.noticePeriod ?? '',
    'noticePeriod'
  );
  const expectedCTC = textInput(
    profile.declarations.expectedCTC ?? '',
    'expectedCTC'
  );
  const currentCTC = textInput(
    profile.declarations.currentCTC ?? '',
    'currentCTC'
  );
  const workAuth = textInput(
    profile.declarations.workAuthorization ?? '',
    'workAuthorization'
  );
  const sponsorship = textInput(
    profile.declarations.requiresSponsorship ?? '',
    'requiresSponsorship'
  );
  declarations.append(
    field('Notice period', noticePeriod),
    field('Expected CTC', expectedCTC),
    field('Current CTC', currentCTC),
    field('Work authorization', workAuth),
    field('Requires sponsorship', sponsorship)
  );

  const prefs = el('fieldset');
  const pLegend = el('legend');
  pLegend.textContent = 'Preferences';
  prefs.append(pLegend);
  const allowLegalLabel = el('label', 'checkbox-row');
  const allowLegal = el('input');
  allowLegal.type = 'checkbox';
  allowLegal.name = 'allowAutofillLegal';
  allowLegal.checked = profile.preferences.allowAutofillLegal === true;
  allowLegalLabel.append(
    allowLegal,
    document.createTextNode(
      ' Allow autofill of visa / criminal / EEO fields (off by default — HLD §9.1)'
    )
  );
  prefs.append(allowLegalLabel);

  const skills = el('fieldset');
  const sLegend = el('legend');
  sLegend.textContent = 'Skills (comma-separated)';
  skills.append(sLegend);
  const primary = textarea(profile.skills.primary.join(', '), 'primary', 2);
  const secondary = textarea(
    profile.skills.secondary.join(', '),
    'secondary',
    2
  );
  skills.append(field('Primary', primary), field('Secondary', secondary));

  const narratives = el('fieldset');
  const nLegend = el('legend');
  nLegend.textContent = 'Narratives';
  narratives.append(nLegend);
  const elevator = textarea(profile.narratives.elevatorPitch, 'elevator', 4);
  const complex = textarea(profile.narratives.complexProject, 'complex', 4);
  const whyLeaving = textarea(profile.narratives.whyLeaving, 'whyLeaving', 3);
  const strengths = textarea(profile.narratives.strengths, 'strengths', 3);
  narratives.append(
    field('Elevator pitch / cover', elevator),
    field('Complex project', complex),
    field('Why leaving', whyLeaving),
    field('Strengths', strengths)
  );

  const saveBtn = el('button', 'btn primary');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Save profile';
  saveBtn.addEventListener('click', () => {
    const next = read();
    profile = next;
    onSave(next);
  });

  root.append(identity, declarations, prefs, skills, narratives, saveBtn);

  function splitCsv(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function nullIfEmpty(s: string): string | null {
    const t = s.trim();
    return t === '' ? null : t;
  }

  function read(): Profile {
    return {
      ...profile,
      schemaVersion: 1,
      identity: {
        firstName: firstName.value.trim(),
        lastName: lastName.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        location: {
          city: city.value.trim(),
          state: state.value.trim(),
          country: country.value.trim(),
        },
        links: {
          linkedin: linkedin.value.trim(),
          github: github.value.trim(),
          portfolio: portfolio.value.trim(),
        },
      },
      skills: {
        primary: splitCsv(primary.value),
        secondary: splitCsv(secondary.value),
      },
      narratives: {
        elevatorPitch: elevator.value,
        complexProject: complex.value,
        whyLeaving: whyLeaving.value,
        strengths: strengths.value,
      },
      declarations: {
        ...profile.declarations,
        noticePeriod: nullIfEmpty(noticePeriod.value),
        expectedCTC: nullIfEmpty(expectedCTC.value),
        currentCTC: nullIfEmpty(currentCTC.value),
        workAuthorization: nullIfEmpty(workAuth.value),
        requiresSponsorship: nullIfEmpty(sponsorship.value),
      },
      preferences: {
        ...profile.preferences,
        allowAutofillLegal: allowLegal.checked,
      },
    };
  }

  function write(p: Profile): void {
    profile = structuredClone(p);
    firstName.value = p.identity.firstName;
    lastName.value = p.identity.lastName;
    email.value = p.identity.email;
    phone.value = p.identity.phone;
    city.value = p.identity.location.city;
    state.value = p.identity.location.state;
    country.value = p.identity.location.country;
    linkedin.value = p.identity.links.linkedin;
    github.value = p.identity.links.github;
    portfolio.value = p.identity.links.portfolio;
    noticePeriod.value = p.declarations.noticePeriod ?? '';
    expectedCTC.value = p.declarations.expectedCTC ?? '';
    currentCTC.value = p.declarations.currentCTC ?? '';
    workAuth.value = p.declarations.workAuthorization ?? '';
    sponsorship.value = p.declarations.requiresSponsorship ?? '';
    allowLegal.checked = p.preferences.allowAutofillLegal === true;
    primary.value = p.skills.primary.join(', ');
    secondary.value = p.skills.secondary.join(', ');
    elevator.value = p.narratives.elevatorPitch;
    complex.value = p.narratives.complexProject;
    whyLeaving.value = p.narratives.whyLeaving;
    strengths.value = p.narratives.strengths;
  }

  return { root, read, write };
}
