// String, regex and set helpers shared across collection, validation and
// rendering. No I/O, no run configuration.
export function uniqueCapture(text, pattern) {
  const values = [];
  for (const match of String(text).matchAll(pattern)) {
    if (match[1]) values.push(match[1]);
  }
  return uniqueSorted(values);
}

export function uniqueMatches(text, pattern) {
  return uniqueSorted(String(text).match(pattern) ?? []);
}

export function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

export function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

export function walkJson(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  for (const item of Object.values(value)) walkJson(item, visit);
}

export function sectionBetween(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start === -1) return '';
  const end = text.indexOf(endMarker, start + startMarker.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

export function extractVersionCell(text, runtimeLabel) {
  const line = text.split(/\r?\n/).find((item) => item.includes(`| ${runtimeLabel} |`));
  if (!line) return null;
  const match = line.match(/\|\s*[^|]+\|\s*`([^`]+)`\s*\|/);
  return match?.[1] ?? null;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeVersion(value) {
  const text = String(value ?? '').trim();
  const codex = text.match(/codex-cli\s+\d+(?:\.\d+){1,3}/);
  if (codex) return codex[0];
  const semver = text.match(/\d+(?:\.\d+){1,3}/);
  if (semver) return semver[0];
  return text;
}

export function firstLine(value) {
  return String(value ?? '').split(/\r?\n/)[0] ?? '';
}

export function trimEnd(value) {
  return String(value ?? '').replace(/\s+$/u, '');
}
