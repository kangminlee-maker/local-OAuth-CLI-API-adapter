// The published adapter must not carry references back to the monorepo it was
// extracted from: its brand, its package namespace, its sibling packages, its
// workspace links, or absolute paths into the checkout.
//
// Sibling package names are rejected wherever they appear, in every packaged
// file. Enumerating the syntaxes that could reference a package — imports,
// subpaths, dependency keys, tsconfig `types`, triple-slash references,
// workspace filters, `pnpm -C`, `yarn workspace`, task keys, project graphs,
// Windows paths — is a losing game, so the bare name is the rule.
//
// One exception, expressed as exact literals in ALLOWED_OCCURRENCES: the Codex
// CLI ships a subcommand named `mcp-server`, and the packaged runtime capability
// catalog documents it in one specific table cell.

const SIBLING_PACKAGES = ['mcp-server', 'ui-gen'];

/**
 * The exception, stated as data rather than as Markdown structure: exact
 * substrings that exact files are allowed to contain.
 *
 * Earlier versions tried to mask "prose code spans", which meant re-deriving
 * Markdown block structure with regular expressions — fenced blocks, indented
 * blocks, blockquoted fences, fence delimiter lengths, malformed closers. Each
 * of those was a bypass, because a backtick pair inside a code block is
 * indistinguishable from an inline span without a real parser.
 *
 * Pinning the literal occurrence removes the entire class: nothing about the
 * document's structure is interpreted. If the catalog's wording changes, the
 * package check fails loudly and this list is updated — a visible failure rather
 * than a silent hole.
 */
const ALLOWED_OCCURRENCES = new Map([
  ['docs/runtime-capability-catalog.md', ['`mcp` / `mcp-server`']],
]);

/**
 * Returns the pattern a file violates, or undefined when it is clean.
 *
 * @param content full text of the packaged file
 * @param filePath package-relative path; when omitted the strict rules apply, so
 *   an unknown caller never gets the documentation exception.
 * @param repoRoot absolute checkout path, which must not leak into the package
 */
export function findForbiddenReference(content, filePath, repoRoot) {
  for (const pattern of monorepoPatterns(repoRoot)) {
    if (pattern.test(content)) return pattern;
  }
  for (const name of SIBLING_PACKAGES) {
    const pattern = strictSiblingPattern(name);
    if (pattern.test(maskAllowedMentions(content, filePath))) return pattern;
  }
  return undefined;
}

/**
 * Removes the exact occurrences this exact file is allowed to contain, so the
 * strict rule runs over everything else. Any other occurrence in the same file —
 * a second mention, a fenced example, an import — survives and is rejected.
 */
export function maskAllowedMentions(content, filePath) {
  const allowed = ALLOWED_OCCURRENCES.get(normalizePath(filePath));
  if (!allowed) return content;
  let masked = content;
  // `replace` with a string removes the FIRST match only, which is the point:
  // the allowance covers one occurrence. A second copy survives and the strict
  // rule rejects it, so the exception cannot be multiplied by repetition.
  for (const occurrence of allowed) masked = masked.replace(occurrence, '');
  return masked;
}

function normalizePath(filePath) {
  return (filePath ?? '').replaceAll('\\', '/');
}

/**
 * Any occurrence of the sibling package name, as a plain substring.
 *
 * No word boundaries: generated build metadata concatenates project names with
 * targets and hashes (`mcp-serverBuild`, `ui-genConfig`, `mcp-servera1b2`), and
 * those identify the sibling just as surely as a bare mention. Boundary rules
 * that let those through buy nothing — an unrelated compound like
 * `mcp-serverless` has no reason to appear in this package, and if one ever
 * does, it belongs in ALLOWED_OCCURRENCES as an exact literal rather than as a
 * hole in the global rule.
 *
 * Case-insensitive, because macOS and Windows filesystems are: `../MCP-SERVER`
 * resolves to the same directory.
 */
export function strictSiblingPattern(name) {
  return new RegExp(escapeRegExp(name), 'iu');
}

/** Monorepo references that no file of any kind may contain. */
export function monorepoPatterns(repoRoot) {
  return [
    legacyBrandPattern(),
    legacyNamespacePattern(),
    /link:\.\.\//,
    new RegExp(escapeRegExp(repoRoot)),
  ];
}

export function legacyNamespacePattern() {
  return new RegExp(`@${'g'}${'gui'}-ai/`);
}

export function legacyBrandPattern() {
  return new RegExp(`${'g'}${'gui'}`, 'i');
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
