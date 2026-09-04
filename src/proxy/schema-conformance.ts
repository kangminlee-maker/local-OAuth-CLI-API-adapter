// `ajv/dist/2020.js` is CommonJS: `module.exports` is the class and also
// carries it as `.default`. Under NodeNext TypeScript types the default import
// as the module object, so the class is taken from its `default` — the same
// function either way at runtime (probed 2026-09-04, ajv 8.20.0).
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';

const Ajv2020 = Ajv2020Module.default;

/**
 * Whether a value conforms to a JSON Schema the CLIENT supplied — a tool's own
 * `parameters` / `input_schema`, or a `json_schema` response format. Those are
 * the schemas the runtime was handed as its output contract, so an answer
 * outside them is a runtime that ignored its schema: the response path refuses
 * it rather than publishing a near miss (conformance matrix §7, rows 8 and 10).
 *
 * `null` means the schema could not be compiled and the answer cannot be
 * judged. That is not a refusal: an unverifiable promise is passed through, and
 * the direct APIs are the ones that reject an invalid schema at request time.
 *
 * Draft 2020-12 with `strict` off, because the schemas are the client's — a
 * keyword Ajv does not know is theirs to have written, not this proxy's to
 * refuse — and formats are not asserted, because neither direct API promises
 * format validation of model output.
 */
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction | null>();
const COMPILED_LIMIT = 256;

export function conformsToSchema(value: unknown, schema: unknown): boolean | null {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const key = JSON.stringify(schema);
  const cached = compiled.get(key);
  let validate: ValidateFunction | null;
  if (cached === undefined) {
    try {
      validate = ajv.compile(schema as Record<string, unknown>);
    } catch {
      validate = null;
    }
    // Schemas arrive per request; a bounded cache keeps a client that varies
    // its schema from growing the process without bound.
    if (compiled.size >= COMPILED_LIMIT) compiled.clear();
    compiled.set(key, validate);
  } else {
    validate = cached;
  }
  if (validate === null) return null;
  return validate(value) === true;
}
