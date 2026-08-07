import type {
  FieldDescriptor,
  FillResultItem,
  ProposedFill,
} from '../shared/types';

export type FieldRowStatus =
  | 'proposed'
  | 'manual'
  | 'filled'
  | 'failed'
  | 'skipped'
  | 'empty'
  | 'amber'
  | 'frozen';

export interface FieldRowModel {
  field: FieldDescriptor;
  proposal?: ProposedFill;
  status: FieldRowStatus;
  statusDetail?: string;
}

function frameBadge(frameId: number): string {
  return frameId === 0 ? 'top' : `iframe #${frameId}`;
}

export function buildFieldRows(
  fields: FieldDescriptor[],
  proposals: ProposedFill[],
  fillResults?: Array<FillResultItem & { frameId: number }>
): FieldRowModel[] {
  const proposalMap = new Map(
    proposals.map((p) => [`${p.frameId}:${p.fieldId}`, p])
  );
  const resultMap = new Map(
    (fillResults ?? []).map((r) => [`${r.frameId}:${r.fieldId}`, r])
  );

  return fields.map((field) => {
    const key = `${field.frameId}:${field.id}`;
    const proposal = proposalMap.get(key);
    const result = resultMap.get(key);

    let status: FieldRowStatus = 'empty';
    let statusDetail: string | undefined;

    if (result) {
      if (result.ok) {
        status = 'filled';
      } else if (result.error === 'skip-nonempty') {
        status = 'skipped';
        statusDetail = 'already had a value';
      } else if (result.error === 'unsupported-widget') {
        status = 'manual';
        statusDetail =
          field.widget === 'file'
            ? "Attach your résumé manually — I can't do file uploads."
            : 'unsupported widget';
      } else if (result.error === 'listbox-never-appeared') {
        status = 'failed';
        statusDetail = 'combobox listbox never appeared — fill manually';
      } else {
        status = 'failed';
        statusDetail = result.error ?? 'fill failed';
      }
    } else if (proposal) {
      if (proposal.tier === 'T-1' && proposal.source === 'unresolved') {
        status = 'frozen';
        statusDetail = proposal.message ?? 'answer yourself';
      } else if (
        proposal.message?.includes('Attach your résumé') ||
        proposal.message === 'unlabelled — fill manually'
      ) {
        status = 'manual';
        statusDetail = proposal.message;
      } else if (proposal.amber || proposal.source === 'generated') {
        status = 'amber';
        statusDetail = `${proposal.source} · ${proposal.tier} · conf ${proposal.confidence.toFixed(2)}`;
      } else if (proposal.value.trim()) {
        status = 'proposed';
        statusDetail = `${proposal.source} · ${proposal.tier}`;
      } else {
        status = 'amber';
        statusDetail = proposal.message ?? 'unresolved';
      }
    } else if (field.currentValue.trim() !== '') {
      status = 'skipped';
      statusDetail = 'already filled';
    }

    return { field, proposal, status, statusDetail };
  });
}

export function renderFieldList(
  container: HTMLElement,
  rows: FieldRowModel[]
): void {
  container.replaceChildren();

  if (rows.length === 0) {
    return;
  }

  const list = document.createElement('ul');
  list.className = 'field-list';

  for (const row of rows) {
    const li = document.createElement('li');
    li.className = `field-row status-${row.status}`;
    if (row.proposal?.amber) li.classList.add('amber');

    const title = document.createElement('div');
    title.className = 'field-title';
    const label = document.createElement('span');
    label.className = 'field-label';
    label.textContent = row.field.label || '(unlabelled)';
    const badge = document.createElement('span');
    badge.className = 'frame-badge';
    badge.textContent = frameBadge(row.field.frameId);
    title.append(label, badge);

    if (row.field.sectionHeading) {
      const section = document.createElement('div');
      section.className = 'field-section';
      section.textContent = row.field.sectionHeading;
      li.append(title, section);
    } else {
      li.append(title);
    }

    if (row.field.sectionKey) {
      const sk = document.createElement('div');
      sk.className = 'field-section-key';
      sk.textContent = `sectionKey: ${row.field.sectionKey}`;
      li.append(sk);
    }

    const meta = document.createElement('div');
    meta.className = 'field-meta';
    const current = row.field.currentValue.trim();
    meta.textContent = current
      ? `Current: ${truncate(current, 48)}`
      : 'Current: (empty)';

    const proposalEl = document.createElement('div');
    proposalEl.className = 'field-proposal';
    if (row.proposal?.value.trim()) {
      const path = row.proposal.profilePath
        ? ` · ${row.proposal.profilePath}`
        : '';
      proposalEl.textContent = `→ ${truncate(row.proposal.value, 48)}  (${row.proposal.source}${path})`;
    } else if (row.proposal?.message) {
      proposalEl.textContent = row.proposal.message;
    } else if (row.status === 'manual') {
      proposalEl.textContent =
        row.statusDetail ?? 'No auto-fill (manual)';
    } else {
      proposalEl.textContent = 'No proposal yet';
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'field-status';
    statusEl.textContent = row.statusDetail
      ? `${row.status}: ${row.statusDetail}`
      : row.status;

    li.append(meta, proposalEl, statusEl);
    list.append(li);
  }

  container.append(list);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
