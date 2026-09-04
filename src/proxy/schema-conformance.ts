// `ajv/dist/2020.js` is CommonJS: `module.exports` is the class and also
// carries it as `.default`. Under NodeNext TypeScript types the default import
// as the module object, so the class is taken from its `default` — the same
// function either way at runtime (probed 2026-09-04, ajv 8.20.0).
import Ajv2020Module from 'ajv/dist/2020.js';
import type { Options, ValidateFunction } from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default;

/**
 * Whether a value conforms to a JSON Schema the CLIENT supplied — a tool's own
 * `parameters` / `input_schema`, or a `json_schema` response format. Those are
 * the schemas the runtime was handed as its output contract, so an answer
 * outside them is a runtime that ignored its schema: the response path refuses
 * it rather than publishing a near miss (conformance matrix §7, rows 8 and 10).
 *
 * `unjudged` means the answer cannot be judged — the schema does not compile,
 * compiles to something this synchronous path cannot read (`$async`), or the
 * text carries a number the double cannot hold exactly. That is not a refusal:
 * an unverifiable promise is passed through. The direct APIs accept `$async`,
 * `$id` and `$ref` at request time (measured 2026-09-04) and produce
 * schema-valid output by construction; this proxy can only judge what it can
 * read exactly.
 *
 * Draft 2020-12 with `strict` off, because the schemas are the client's — a
 * keyword Ajv does not know is theirs to have written, not this proxy's to
 * refuse — and formats are not asserted, because neither direct API promises
 * format validation of model output.
 */
const OPTIONS: Options = { strict: false, allErrors: false, validateFormats: false };
const compiled = new Map<string, ValidateFunction | null>();
const COMPILED_LIMIT = 256;

export type SchemaJudgement = 'conforms' | 'violates' | 'unjudged' | 'not-json';

/** Judge the runtime's bytes against the client's schema. */
export function judgeJsonText(text: string, schema: unknown): SchemaJudgement {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return 'not-json';
  }
  const verdict = conformsToSchema(value, schema);
  if (verdict === null) return 'unjudged';
  if (verdict) return 'conforms';
  // `JSON.parse` rounds: `9007199254740993` to `…992`, `0.3` to a double that
  // is not a multiple of `0.1`'s, `1e-999` to zero. A violation judged on a
  // rounded value may be the rounding's, not the runtime's, and the client is
  // promised the runtime's bytes (matrix chat row 28) — so it is not a
  // verdict. A conforming answer is delivered either way.
  return hasInexactNumber(text) ? 'unjudged' : 'violates';
}

export function conformsToSchema(value: unknown, schema: unknown): boolean | null {
  const validate = validatorFor(schema);
  if (validate === null) return null;
  try {
    return validate(value) === true;
  } catch {
    return null;
  }
}

function validatorFor(schema: unknown): ValidateFunction | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  if (cached !== undefined) return cached;
  let validate: ValidateFunction | null;
  try {
    // One instance per schema. `compile` registers the schema's `$id` on the
    // instance it ran on, and a shared instance let one request decide
    // another's verdict: a `$ref` resolving to a stranger's schema, or a
    // second schema under a taken `$id` failing to compile at all.
    const validator = new Ajv2020(OPTIONS).compile(schema as Record<string, unknown>);
    // `$async: true` compiles to a validator that returns a promise and
    // rejects on failure — nothing a synchronous judgement can read, and an
    // unhandled rejection that used to end the process.
    validate = (validator as { $async?: boolean }).$async === true ? null : validator;
  } catch {
    validate = null;
  }
  // Schemas arrive per request; a bounded cache keeps a client that varies
  // its schema from growing the process without bound, and the instance a
  // validator closed over goes with it.
  if (compiled.size >= COMPILED_LIMIT) compiled.clear();
  compiled.set(key, validate);
  return validate;
}

/**
 * Whether the JSON text carries a number lexeme whose mathematical value is
 * not the value of the double `JSON.parse` makes of it — an integer past
 * 2^53, a decimal such as `0.3`, an exponent that overflows or underflows.
 * Decided by value, not by digit count (round 19): `9007199254740992` and
 * `1e16` are exact and are judged; `0.3` is not, and a verdict that may rest
 * on its rounding is not a verdict. Strings are skipped.
 */
export function hasInexactNumber(text: string): boolean {
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end] as string)) end += 1;
      if (numberIsInexact(text.slice(i, end))) return true;
      i = end - 1;
    }
  }
  return false;
}

const NUMBER_LEXEME = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** Whether the lexeme's exact value differs from the double it parses to. */
export function numberIsInexact(lexeme: string): boolean {
  const parts = NUMBER_LEXEME.exec(lexeme);
  if (!parts) return true;
  const value = Number(lexeme);
  if (!Number.isFinite(value)) return true;
  const [, sign, whole, fraction = '', exponent = '0'] = parts;
  // A mantissa this long is not one a double holds, and the comparison below
  // would scale BigInts by its length; decide without it (r20).
  if (whole.length + fraction.length > 4096) return true;
  // The lexeme as D × 10^E.
  let decimal = BigInt(whole + fraction);
  if (sign === '-') decimal = -decimal;
  // Zero first: `1e-999999999` underflows to it, and scaling the comparison by
  // 10^999999999 would exceed BigInt's size (or burn seconds below it).
  // After this, a finite non-zero double bounds |E| by the mantissa's length
  // plus the double's own exponent range.
  if (value === 0) return decimal !== 0n;
  const decimalExponent = Number(exponent) - fraction.length;
  // The double as M × 2^P, exactly.
  const { mantissa, exponent: binaryExponent } = decompose(value);
  // D × 10^E = M × 2^P, cross-multiplied into integers.
  const left = decimal * 10n ** BigInt(Math.max(decimalExponent, 0)) * 2n ** BigInt(Math.max(-binaryExponent, 0));
  const right = mantissa * 2n ** BigInt(Math.max(binaryExponent, 0)) * 10n ** BigInt(Math.max(-decimalExponent, 0));
  return left !== right;
}

function decompose(value: number): { mantissa: bigint; exponent: number } {
  if (value === 0) return { mantissa: 0n, exponent: 0 };
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const negative = high >>> 31 === 1;
  const biased = (high >>> 20) & 0x7ff;
  const fractionBits = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const mantissa = biased === 0 ? fractionBits : fractionBits | (1n << 52n);
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  return { mantissa: negative ? -mantissa : mantissa, exponent };
}
