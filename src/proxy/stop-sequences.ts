/**
 * Anthropic `stop_sequences`, realized on the output.
 *
 * The direct API stops generating at the first sequence it emits, returns the
 * text BEFORE it, and reports `stop_reason: "stop_sequence"` with
 * `stop_sequence` set to the one that matched (measured 2026-08-30, probe P-8:
 * a turn told to say `AAZZBB` with `stop_sequences: ["ZZ"]` answers `AA`). The
 * Claude CLI has no such knob — no flag in the runtime capability catalogue
 * carries it — so the option rules put this in the response path: it is
 * checkable in code, which is what makes it a realization rather than a
 * prompt.
 *
 * The runtime still generates the whole turn; only the reported text is cut.
 * That is stated in the contract, because it is the one thing a client can
 * observe as different: the usage reported is the whole turn's.
 */
export interface StopSequenceMatch {
  /** Where the sequence starts — the text before it is what the caller gets. */
  readonly index: number;
  readonly sequence: string;
}

/**
 * The earliest sequence in the text. Ties — two sequences starting at the same
 * index, e.g. `ZZ` and `ZZZ` — go to the caller's own array order, which is
 * this proxy's rule: the direct API's tie-break was not measured, and picking
 * by length would be just as arbitrary while looking authoritative.
 */
export function matchStopSequence(
  text: string,
  sequences: readonly string[],
): StopSequenceMatch | null {
  let best: StopSequenceMatch | null = null;
  for (const sequence of sequences) {
    if (!sequence) continue;
    const index = text.indexOf(sequence);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, sequence };
  }
  return best;
}

export function truncateAtStopSequence(
  text: string,
  sequences: readonly string[],
): { readonly text: string; readonly sequence: string | null } {
  const match = matchStopSequence(text, sequences);
  return match ? { text: text.slice(0, match.index), sequence: match.sequence } : { text, sequence: null };
}

/**
 * The streaming half. A sequence can arrive split across two deltas, so the
 * gate holds back the longest tail that could still become one and releases it
 * once it cannot. Without that hold-back, `Z` + `Z` would both reach the client
 * and the match would be found only after the client had already read it.
 */
export class StopSequenceGate {
  private held = '';
  private matched: string | null = null;

  constructor(private readonly sequences: readonly string[]) {}

  get active(): boolean {
    return this.sequences.some((sequence) => sequence.length > 0);
  }

  /** The sequence that ended the output, once one has. */
  get stopped(): string | null {
    return this.matched;
  }

  /**
   * Feeds one delta through the gate and returns the text that may be written
   * now. Everything after a match is dropped: the turn is over as far as the
   * caller is concerned.
   */
  push(delta: string): string {
    if (!this.active) return delta;
    if (this.matched) return '';
    const buffer = this.held + delta;
    const match = matchStopSequence(buffer, this.sequences);
    if (match) {
      this.held = '';
      this.matched = match.sequence;
      return buffer.slice(0, match.index);
    }
    const hold = partialSuffixLength(buffer, this.sequences);
    this.held = hold === 0 ? '' : buffer.slice(buffer.length - hold);
    return buffer.slice(0, buffer.length - hold);
  }

  /** The held-back tail, once the turn has ended without a match. */
  flush(): string {
    if (this.matched) return '';
    const rest = this.held;
    this.held = '';
    return rest;
  }
}

/**
 * How much of the buffer's tail could still turn into a sequence: the longest
 * suffix of `buffer` that is a proper prefix of one of them.
 */
function partialSuffixLength(buffer: string, sequences: readonly string[]): number {
  let longest = 0;
  for (const sequence of sequences) {
    const max = Math.min(sequence.length - 1, buffer.length);
    for (let length = max; length > longest; length -= 1) {
      if (sequence.startsWith(buffer.slice(buffer.length - length))) {
        longest = length;
        break;
      }
    }
  }
  return longest;
}
