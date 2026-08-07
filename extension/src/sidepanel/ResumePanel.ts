import { sendRuntimeMessage } from '../shared/messaging';
import type { ResumeMeta } from '../shared/types';

const MAX_BYTES = 8 * 1024 * 1024; // resumes are small; guard against picking the wrong file

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.onload = () => {
      const result = reader.result as string; // data:<mime>;base64,<b64>
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

export interface ResumePanelHandle {
  root: HTMLElement;
  refresh(): Promise<void>;
}

export function createResumePanel(): ResumePanelHandle {
  const root = document.createElement('div');
  root.className = 'resume-panel';

  const status = document.createElement('p');
  status.className = 'resume-status';
  status.textContent = 'No résumé stored.';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  const row = document.createElement('div');
  row.className = 'settings-actions';
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'btn';
  uploadBtn.textContent = 'Upload résumé';
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn';
  removeBtn.textContent = 'Remove';
  removeBtn.hidden = true;
  row.append(uploadBtn, removeBtn);

  root.append(status, fileInput, row);

  function writeMeta(resume: ResumeMeta | null): void {
    if (resume) {
      status.textContent = `${resume.filename} (${formatSize(resume.sizeBytes)}) — attached automatically to résumé/CV upload fields.`;
      removeBtn.hidden = false;
    } else {
      status.textContent = 'No résumé stored — file upload fields are skipped.';
      removeBtn.hidden = true;
    }
  }

  async function refresh(): Promise<void> {
    const resp = (await sendRuntimeMessage({ type: 'GET_RESUME' })) as {
      resume: ResumeMeta | null;
    };
    writeMeta(resp?.resume ?? null);
  }

  uploadBtn.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      status.textContent = 'Choose a file first.';
      return;
    }
    if (file.size > MAX_BYTES) {
      status.textContent = `File too large (${formatSize(file.size)}) — max ${formatSize(MAX_BYTES)}.`;
      return;
    }
    status.textContent = 'Uploading…';
    void fileToBase64(file)
      .then((dataB64) =>
        sendRuntimeMessage({
          type: 'SAVE_RESUME',
          filename: file.name,
          mimeType: file.type,
          dataB64,
        })
      )
      .then(() => {
        fileInput.value = '';
        return refresh();
      })
      .catch((err) => {
        status.textContent = `Upload failed: ${err instanceof Error ? err.message : String(err)}`;
      });
  });

  removeBtn.addEventListener('click', () => {
    void sendRuntimeMessage({ type: 'DELETE_RESUME' }).then(() => refresh());
  });

  return { root, refresh };
}
