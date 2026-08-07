import {
  DEFAULT_LOCAL_PASSPHRASE,
  DEFAULT_MODELS,
  OPENAI_PINNED_MODEL,
} from '../shared/settingsDefaults';
import { sendRuntimeMessage } from '../shared/messaging';
import type {
  BudgetSettings,
  ProviderName,
  SettingsPublic,
} from '../shared/types';

export function createSettingsPanel(opts: {
  onChanged: () => void;
}): {
  root: HTMLElement;
  write: (settings: SettingsPublic, unlocked: boolean) => void;
} {
  const root = document.createElement('div');
  root.className = 'settings-panel';

  let settings: SettingsPublic | null = null;
  let unlocked = false;

  const status = document.createElement('p');
  status.className = 'settings-status';

  const providerLabel = document.createElement('label');
  providerLabel.className = 'profile-field';
  providerLabel.textContent = 'Provider';
  const providerSelect = document.createElement('select');
  for (const p of ['anthropic', 'openai', 'groq'] as ProviderName[]) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    providerSelect.append(opt);
  }
  providerLabel.append(providerSelect);

  const modelLabel = document.createElement('label');
  modelLabel.className = 'profile-field';
  const modelLabelText = document.createTextNode('Model');
  modelLabel.append(modelLabelText);
  const modelInput = document.createElement('input');
  modelInput.type = 'text';
  modelLabel.append(modelInput);

  /** OpenAI model is pinned and not user-selectable. */
  function applyModelLock(): void {
    if (providerSelect.value === 'openai') {
      modelInput.value = OPENAI_PINNED_MODEL;
      modelInput.readOnly = true;
      modelInput.title = 'OpenAI model is pinned and cannot be changed.';
      modelLabelText.nodeValue = 'Model (pinned)';
    } else {
      modelInput.readOnly = false;
      modelInput.title = '';
      modelLabelText.nodeValue = 'Model';
    }
  }

  const keyLabel = document.createElement('label');
  keyLabel.className = 'profile-field';
  keyLabel.textContent = 'API key (BYOK)';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.placeholder = 'sk-… / gsk_…';
  keyLabel.append(keyInput);

  const passLabel = document.createElement('label');
  passLabel.className = 'profile-field';
  passLabel.textContent = 'Passphrase (optional — leave blank for local default)';
  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.autocomplete = 'off';
  passLabel.append(passInput);

  const keyRow = document.createElement('div');
  keyRow.className = 'settings-actions';
  const saveKeyBtn = document.createElement('button');
  saveKeyBtn.type = 'button';
  saveKeyBtn.className = 'btn primary';
  saveKeyBtn.textContent = 'Save & unlock key';
  const unlockBtn = document.createElement('button');
  unlockBtn.type = 'button';
  unlockBtn.className = 'btn';
  unlockBtn.textContent = 'Unlock session';
  const lockBtn = document.createElement('button');
  lockBtn.type = 'button';
  lockBtn.className = 'btn';
  lockBtn.textContent = 'Lock';
  keyRow.append(saveKeyBtn, unlockBtn, lockBtn);

  const debugLabel = document.createElement('label');
  debugLabel.className = 'checkbox-row';
  const debugInput = document.createElement('input');
  debugInput.type = 'checkbox';
  debugLabel.append(
    debugInput,
    document.createTextNode(' Debug: show T0 / T1 / LLM scores')
  );

  const mappingTitle = document.createElement('p');
  mappingTitle.className = 'settings-subtitle';
  mappingTitle.textContent = 'Field mapping cache (T0)';

  const mappingRow = document.createElement('div');
  mappingRow.className = 'settings-actions';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'btn';
  exportBtn.textContent = 'Export mappings';
  const exportAllBtn = document.createElement('button');
  exportAllBtn.type = 'button';
  exportAllBtn.className = 'btn';
  exportAllBtn.textContent = 'Export + answers';
  const importBtn = document.createElement('button');
  importBtn.type = 'button';
  importBtn.className = 'btn';
  importBtn.textContent = 'Import JSON…';
  const importFile = document.createElement('input');
  importFile.type = 'file';
  importFile.accept = 'application/json,.json';
  importFile.hidden = true;
  mappingRow.append(exportBtn, exportAllBtn, importBtn, importFile);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'Save settings';

  root.append(
    status,
    providerLabel,
    modelLabel,
    keyLabel,
    passLabel,
    keyRow,
    debugLabel,
    mappingTitle,
    mappingRow,
    saveBtn
  );

  function setStatus(t: string): void {
    status.textContent = t;
  }

  function write(next: SettingsPublic, sessionUnlocked: boolean): void {
    settings = next;
    unlocked = sessionUnlocked;
    providerSelect.value = next.provider;
    modelInput.value = next.model;
    applyModelLock();
    debugInput.checked = next.debug;
    keyInput.placeholder = next.hasApiKey
      ? '(key saved — enter to replace)'
      : 'sk-… / gsk_…';
    setStatus(
      sessionUnlocked
        ? 'Session unlocked — LLM ready'
        : next.hasApiKey
          ? 'Key saved — unlock with passphrase'
          : 'No API key yet'
    );
  }

  providerSelect.addEventListener('change', () => {
    const p = providerSelect.value as ProviderName;
    if (!modelInput.value.trim() || Object.values(DEFAULT_MODELS).includes(modelInput.value)) {
      modelInput.value = DEFAULT_MODELS[p];
    }
    applyModelLock();
  });

  saveKeyBtn.addEventListener('click', () => {
    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      setStatus('Enter your API key.');
      return;
    }
    const passphrase = passInput.value || DEFAULT_LOCAL_PASSPHRASE;
    void sendRuntimeMessage({
      type: 'SET_API_KEY',
      apiKey,
      passphrase,
    }).then((resp) => {
      const r = resp as { ok?: boolean; error?: string };
      if (r?.ok) {
        keyInput.value = '';
        setStatus('Key encrypted and session unlocked.');
        unlocked = true;
        opts.onChanged();
      } else {
        setStatus(r?.error ?? 'Failed to save key');
      }
    });
  });

  unlockBtn.addEventListener('click', () => {
    const passphrase = passInput.value || DEFAULT_LOCAL_PASSPHRASE;
    void sendRuntimeMessage({
      type: 'UNLOCK_SESSION',
      passphrase,
    }).then((resp) => {
      const r = resp as { ok?: boolean; error?: string };
      if (r?.ok) {
        unlocked = true;
        setStatus('Session unlocked.');
        opts.onChanged();
      } else {
        setStatus(r?.error ?? 'Unlock failed');
      }
    });
  });

  lockBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'LOCK_SESSION' }).then(() => {
      unlocked = false;
      setStatus('Session locked.');
      opts.onChanged();
    });
  });

  saveBtn.addEventListener('click', () => {
    // Spend limits removed from the UI — run unlimited (personal use).
    const budget: BudgetSettings = {
      maxCallsPerPage: Number.MAX_SAFE_INTEGER,
      maxCallsPerDay: Number.MAX_SAFE_INTEGER,
      maxSpendPerDayUSD: Number.MAX_SAFE_INTEGER,
    };
    void sendRuntimeMessage({
      type: 'SAVE_SETTINGS',
      settings: {
        provider: providerSelect.value as ProviderName,
        model: modelInput.value.trim(),
        budget,
        // Threshold no longer user-tunable — keep the stored value or default.
        similarityThreshold: settings?.similarityThreshold ?? 0.85,
        debug: debugInput.checked,
      },
    }).then(() => {
      setStatus('Settings saved.');
      opts.onChanged();
    });
  });

  function downloadJson(filename: string, data: unknown): void {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  exportBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'EXPORT_MAPPINGS', includeAnswers: false }).then(
      (resp) => {
        const r = resp as { pack?: unknown; error?: string };
        if (r?.error || !r?.pack) {
          setStatus(r?.error ?? 'Export failed');
          return;
        }
        downloadJson(`pleo-field-mappings-${Date.now()}.json`, r.pack);
        setStatus('Mappings exported.');
      }
    );
  });

  exportAllBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'EXPORT_MAPPINGS', includeAnswers: true }).then(
      (resp) => {
        const r = resp as { pack?: unknown; error?: string };
        if (r?.error || !r?.pack) {
          setStatus(r?.error ?? 'Export failed');
          return;
        }
        downloadJson(`pleo-mappings-answers-${Date.now()}.json`, r.pack);
        setStatus('Mappings + answers exported.');
      }
    );
  });

  importBtn.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pack = JSON.parse(String(reader.result));
        void sendRuntimeMessage({
          type: 'IMPORT_MAPPINGS',
          pack,
          replace: false,
        }).then((resp) => {
          const r = resp as {
            ok?: boolean;
            mappings?: number;
            answers?: number;
            error?: string;
          };
          if (!r?.ok) {
            setStatus(r?.error ?? 'Import failed');
            return;
          }
          setStatus(
            `Imported ${r.mappings ?? 0} mapping(s)` +
              (r.answers ? `, ${r.answers} answer(s)` : '') +
              '.'
          );
          opts.onChanged();
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Invalid JSON');
      }
    };
    reader.readAsText(file);
  });

  return { root, write };
}

