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
    // A match is not enough: a sequence that is still only half-arrived can
    // beat it once the rest lands. With `["abc","ab"]` and the text `XabcY`,
    // `ab` matches the moment `Xab` arrives, but the buffered path answers
    // `abc` — same index, and `abc` is listed first. Committing here would
    // make the same turn report a different `stop_sequence` depending on
    // whether the caller streamed it.
    const pending = pendingWinnerIndex(buffer, this.sequences, match);
    if (match && pending === -1) {
      this.held = '';
      this.matched = match.sequence;
      return buffer.slice(0, match.index);
    }
    const holdFrom = pending === -1 ? buffer.length : pending;
    this.held = buffer.slice(holdFrom);
    return buffer.slice(0, holdFrom);
  }

  /** What the gate is still holding back, without resolving anything. */
  get pending(): string {
    return this.held;
  }

  /**
   * The turn is over, so nothing outstanding can arrive to beat a match any
   * more: whatever is held resolves now. Without this the deferral above would
   * turn a real match into no match at all — `["abc","ab"]` over a turn that
   * ends at `ab` must still report `ab`, as the buffered path does.
   */
  flush(): string {
    if (this.matched) return '';
    const buffer = this.held;
    this.held = '';
    const match = matchStopSequence(buffer, this.sequences);
    if (!match) return buffer;
    this.matched = match.sequence;
    return buffer.slice(0, match.index);
  }
}

/**
 * Where the earliest still-possible sequence would start, counting only the
 * ones that would BEAT `match` — start earlier, or start level and be listed
 * earlier, which is exactly `matchStopSequence`'s own rule. Returns -1 when
 * nothing outstanding can change the answer, which is the only moment a match
 * is safe to commit.
 *
 * A half-arrived sequence always runs to the end of the buffer, so only the
 * buffer's suffixes can be one, and the longest qualifying suffix is the
 * earliest start.
 */
function pendingWinnerIndex(
  buffer: string,
  sequences: readonly string[],
  match: StopSequenceMatch | null,
): number {
  const matchRank = match ? sequences.indexOf(match.sequence) : -1;
  const longest = Math.max(0, ...sequences.map((sequence) => sequence.length - 1));
  for (let length = Math.min(longest, buffer.length); length > 0; length -= 1) {
    const index = buffer.length - length;
    if (match && index > match.index) continue;
    const tail = buffer.slice(index);
    for (const [rank, sequence] of sequences.entries()) {
      if (sequence.length <= tail.length || !sequence.startsWith(tail)) continue;
      if (!match || index < match.index || rank < matchRank) return index;
    }
  }
  return -1;
}
