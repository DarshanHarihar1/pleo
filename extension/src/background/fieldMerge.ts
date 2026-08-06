import type { FieldDescriptor, FieldDescriptorPayload } from '../shared/types';

/**
 * Stamp frameId and merge: top frame (0) first, then by frameId,
 * stable discovery order within a frame.
 */
export function mergeFields(
  batches: Array<{ frameId: number; fields: FieldDescriptorPayload[] }>
): FieldDescriptor[] {
  const stamped: FieldDescriptor[] = [];
  for (const batch of batches) {
    for (const f of batch.fields) {
      stamped.push({ ...f, frameId: batch.frameId });
    }
  }

  stamped.sort((a, b) => {
    if (a.frameId !== b.frameId) {
      if (a.frameId === 0) return -1;
      if (b.frameId === 0) return 1;
      return a.frameId - b.frameId;
    }
    return 0; // stable within frame (discovery order preserved by sort stability)
  });

  return stamped;
}

export function fieldKey(frameId: number, fieldId: string): string {
  return `${frameId}:${fieldId}`;
}
