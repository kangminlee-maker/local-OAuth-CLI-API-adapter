import { randomUUID } from 'node:crypto';

/**
 * JSON text that goes into a response body exactly as it is.
 *
 * A tool call's arguments are the bytes the runtime wrote. Where a surface
 * publishes them inside a JSON string (Chat and Responses `arguments`) the
 * string carries them intact; where it publishes them as a JSON value
 * (Messages `input`) a `JSON.parse` + `JSON.stringify` round trip rounds every
 * number through IEEE-754 first — `9007199254740993` went out as `…992` and
 * `1e999` as `null`, while the stream of the same turn carried the bytes. The
 * writer wraps the text in this and `stringifyJson` splices it in verbatim.
 */
export class RawJson {
  readonly text: string;

  constructor(text: string) {
    // A body that does not parse is a programming error here, never a
    // client-visible one: every caller holds text it has already parsed or
    // assembled from parsed slices.
    JSON.parse(text);
    this.text = text;
  }
}

/**
 * `JSON.stringify`, with every `RawJson` value emitted as its own text.
 *
 * Each raw value is stood in for by a one-off placeholder string (a random
 * nonce plus its index) during serialization and spliced back afterwards; the
 * nonce is generated per call, so no client- or model-authored string can be
 * mistaken for a placeholder, and the count of splices is asserted.
 */
export function stringifyJson(payload: unknown): string {
  const raws: string[] = [];
  const nonce = randomUUID();
  const text = JSON.stringify(payload, (_key, value: unknown) =>
    (value instanceof RawJson ? `${nonce}:${raws.push(value.text) - 1}` : value));
  if (raws.length === 0) return text;
  let spliced = 0;
  const out = text.replace(new RegExp(`"${nonce}:(\\d+)"`, 'g'), (_match, index: string) => {
    spliced += 1;
    return raws[Number(index)] ?? '';
  });
  if (spliced !== raws.length) {
    throw new Error(`raw JSON splice: ${raws.length} values, ${spliced} placeholders found`);
  }
  return out;
}
