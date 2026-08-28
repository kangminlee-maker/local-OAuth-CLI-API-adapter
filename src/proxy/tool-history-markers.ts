/**
 * How a tool turn is written into a flattened prompt, and how it is read back.
 *
 * The normalizer writes these markers, the codex transport reads them back into
 * this API's own tool items, and the multimodal builder reads them to say which
 * call an image answers. Three places agreeing on a literal by memory is three
 * places to get it wrong, so the literal — and the one line that finds a call
 * id inside it — live here.
 */
export const ASSISTANT_TOOL_CALL_MARKER = '[assistant tool_call]';
export const TOOL_RESULT_MARKER = '[tool result]';

/** The call a flattened tool result answers, or null when the text is not one. */
export function toolResultCallId(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(TOOL_RESULT_MARKER)) return null;
  const line = trimmed.split(/\r?\n/).find((candidate) => candidate.startsWith('tool_call_id:'));
  if (!line) return null;
  const id = line.slice('tool_call_id:'.length).trim();
  return id || null;
}

/**
 * Where a marker begins, counting only line starts. The flattener joins blocks
 * with blank lines, so a marker can sit anywhere in a message — after the
 * narration the model wrote alongside its call, for instance — and a check that
 * only looked at position 0 declared such a message "not tool history" and
 * dropped the call it contained.
 */
export function markerIndex(text: string, marker: string): number {
  if (text.startsWith(marker)) return 0;
  const at = text.indexOf(`\n${marker}`);
  return at === -1 ? -1 : at + 1;
}

/** One entry per marker occurrence, each starting at its marker. */
export function splitAtMarkers(text: string, marker: string): string[] {
  const blocks: string[] = [];
  let cursor = markerIndex(text, marker);
  while (cursor !== -1) {
    const next = markerIndex(text.slice(cursor + marker.length), marker);
    const end = next === -1 ? text.length : cursor + marker.length + next;
    blocks.push(text.slice(cursor, end).trim());
    cursor = next === -1 ? -1 : cursor + marker.length + next;
  }
  return blocks;
}
