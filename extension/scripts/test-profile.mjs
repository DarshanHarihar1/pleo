/**
 * Realistic (but synthetic) candidate profile used for live ATS testing.
 * Never a real person; safe to write into forms. We never submit.
 */
export const TEST_PROFILE = {
  schemaVersion: 1,
  identity: {
    firstName: 'Aarav',
    lastName: 'Mehta',
    email: 'aarav.mehta.dev@gmail.com',
    phone: '+91 98450 12345',
    location: { city: 'Bengaluru', state: 'Karnataka', country: 'India' },
    links: {
      linkedin: 'https://www.linkedin.com/in/aarav-mehta-dev',
      github: 'https://github.com/aaravmehta-dev',
      portfolio: 'https://aaravmehta.dev',
    },
  },
  experience: [
    {
      company: 'Nimbus Labs',
      title: 'Senior Software Engineer',
      startDate: '2022-03',
      endDate: null,
      location: 'Bengaluru, India',
      summary:
        'Lead engineer on a browser-extension platform and TypeScript services team.',
      bullets: [
        'Built an MV3 autofill pipeline with frame-aware DOM extraction and React-safe writeback.',
        'Cut form-completion time 60% and shipped BYOK LLM resolution with spend guardrails.',
        'Mentored 4 engineers and owned the extraction test harness.',
      ],
      technologies: ['TypeScript', 'Node.js', 'Chrome Extensions', 'esbuild', 'Vitest'],
    },
    {
      company: 'Finlytics',
      title: 'Software Engineer',
      startDate: '2019-06',
      endDate: '2022-02',
      location: 'Pune, India',
      summary: 'Full-stack engineer on a payments dashboard.',
      bullets: [
        'Owned the React data-grid and reporting exports used by 10k+ merchants.',
        'Reduced p95 API latency 40% via query and cache refactors.',
      ],
      technologies: ['TypeScript', 'React', 'PostgreSQL', 'AWS'],
    },
  ],
  education: [
    {
      institution: 'BITS Pilani',
      degree: 'B.E.',
      field: 'Computer Science',
      endYear: 2019,
    },
  ],
  skills: {
    primary: ['TypeScript', 'JavaScript', 'React', 'Node.js', 'Chrome Extensions'],
    secondary: ['PostgreSQL', 'AWS', 'Python', 'GraphQL'],
  },
  narratives: {
    elevatorPitch:
      'Senior software engineer with 6+ years building reliable TypeScript products and browser tooling. I care about clean abstractions, fast feedback loops, and shipping things people actually use.',
    complexProject:
      'I designed and shipped an MV3 job-application autofill engine: frame-aware field extraction, a tiered resolution pipeline (cache → heuristic → answer memory → LLM), React-safe writeback, and per-page spend guardrails. The hardest part was making writeback survive controlled React inputs and custom comboboxes without ever auto-submitting.',
    whyLeaving:
      'I have grown a lot in my current role and am looking for a larger technical scope and product ownership.',
    strengths:
      'TypeScript, browser-extension architecture, pragmatic system design, and mentoring.',
  },
  declarations: {
    workAuthorization: 'Yes — authorized to work in India',
    requiresSponsorship: 'No',
    noticePeriod: '30 days',
    expectedCTC: '32 LPA',
    currentCTC: '24 LPA',
    criminalRecord: null,
    eeo: null,
  },
  preferences: {
    neverAutofill: ['references', 'eeo', 'criminalRecord'],
  },
};

/** Distinctive values we can look for in the DOM to confirm a fill landed. */
export const IDENTITY_PROBE_VALUES = [
  'Aarav',
  'Mehta',
  'aarav.mehta.dev@gmail.com',
  '+91 98450 12345',
];
