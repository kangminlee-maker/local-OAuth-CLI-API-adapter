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
  // `JSON.parse` rounds `9007199254740993` to `…992`, and a constraint judged
  // on the rounded value can refuse bytes that satisfy it. The client is
  // promised the runtime's bytes (matrix chat row 28), so a text carrying a
  // number lexeme the double cannot represent exactly is not judged.
  if (hasInexactNumber(text)) return 'unjudged';
  const verdict = conformsToSchema(value, schema);
  if (verdict === null) return 'unjudged';
  return verdict ? 'conforms' : 'violates';
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
 * Whether the JSON text carries a number lexeme a double cannot hold exactly:
 * an integer beyond 2^53, or a decimal with more significant digits than a
 * double round-trips (15). Strings are skipped, so a digit inside one does
 * not count.
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

function numberIsInexact(lexeme: string): boolean {
  if (/^-?\d+$/.test(lexeme)) {
    const digits = lexeme.replace('-', '').replace(/^0+(?=\d)/, '');
    return digits.length > 16 || (digits.length === 16 && BigInt(digits) > BigInt(Number.MAX_SAFE_INTEGER));
  }
  const mantissa = lexeme.replace(/^-/, '').replace(/[eE].*$/, '').replace('.', '').replace(/^0+/, '');
  return mantissa.length > 15;
}
