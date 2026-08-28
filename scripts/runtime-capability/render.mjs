// Report rendering. Presentation only; every number comes from the collected
// data or the validity result.
import { firstLine } from './text.mjs';

export function renderMarkdown(data) {
  return `# Runtime Capability Report

Generated at: ${data.generatedAt}

Repository: \`${data.repoRoot}\`

Catalog: \`${data.catalogPath}\`

Platform: \`${data.platform.os}/${data.platform.arch} ${data.platform.release}\`, Node \`${data.platform.node}\`

## Local Runtime Summary

| Runtime | Exists | Version | Command on PATH | Scan target |
| --- | --- | --- | --- | --- |
| Codex CLI | ${yesNo(data.codex.exists)} | ${inline(firstLine(data.codex.version?.stdout))} | ${inline(data.codex.binary)} | ${data.codex.scanBinary ? inline(data.codex.scanBinary) : 'none confirmed'} |
| Claude Code | ${yesNo(data.claude.exists)} | ${inline(firstLine(data.claude.version?.stdout))} | ${inline(data.claude.binary)} | ${data.claude.scanBinary ? inline(data.claude.scanBinary) : 'none confirmed'} |

## Catalog Validity

Verdict: \`${data.catalogValidity?.verdict ?? 'not_checked'}\`

| Check | Count |
| --- | ---: |
| Stale or changed entries | ${data.catalogValidity?.staleCount ?? 0} |
| Additive update candidates | ${data.catalogValidity?.updateCandidateCount ?? 0} |
| CLI spawns this run | ${data.probes?.count ?? 'n/a'} in ${data.probes?.totalMs ?? 'n/a'}ms (budget ${data.probes?.budgetMs ?? 'n/a'}ms${data.probes?.exhausted ? ', EXHAUSTED' : ''}) |
| Reasons the run could not conclude | ${(data.catalogValidity?.inconclusiveReasons ?? []).length > 0 ? data.catalogValidity.inconclusiveReasons.map((value) => inline(value)).join('; ') : 'none'} |
| Codex option probes whose controls failed | ${(data.catalogValidity?.codexOptionUses?.controlsFailed ?? []).length > 0 ? data.catalogValidity.codexOptionUses.controlsFailed.map((value) => inline(value)).join(', ') : 'none'} |
| Codex documented methods missing from schema | ${data.catalogValidity?.codex?.documentedMethodsMissingFromSchema?.length ?? 0} |
| Codex schema methods undocumented in catalog | ${data.catalogValidity?.codex?.schemaMethodsUndocumentedInCatalog?.length ?? 0} |
| Claude documented flags missing from help/docs-only list | ${data.catalogValidity?.claude?.documentedFlagsMissingFromHelpOrDocs?.length ?? 0} |
| Claude help flags undocumented in catalog | ${data.catalogValidity?.claude?.helpFlagsUndocumentedInCatalog?.length ?? 0} |
| Documented commands the CLI no longer has | ${(data.catalogValidity?.commands?.codex?.absent?.length ?? 0) + (data.catalogValidity?.commands?.claude?.absent?.length ?? 0)} |
| Documented option domains that disagree with the CLI | ${data.catalogValidity?.optionDomainMismatches?.length ?? 0} |
| Documented codex options the CLI no longer accepts | ${data.catalogValidity?.codexOptionUses?.absent?.length ?? 0} |
| Request contracts that disagree with the schema | ${data.catalogValidity?.requestContractMismatches?.length ?? 0} |
| Options present but undocumented | ${(data.catalogValidity?.undocumentedOptions?.codexCount ?? 0) + (data.catalogValidity?.undocumentedOptions?.claudeCount ?? 0)} |
| Commands present but undocumented | ${(data.catalogValidity?.commands?.codex?.undocumented?.length ?? 0) + (data.catalogValidity?.commands?.claude?.undocumented?.length ?? 0)} |

### Documented Commands

| Runtime | Authority | Documented | In command tree | Hidden, probe-confirmed | Could not tell | Absent |
| --- | --- | ---: | ---: | ---: | ---: | --- |
${['codex', 'claude'].map((runtime) => {
  const check = data.catalogValidity?.commands?.[runtime];
  const absent = check?.absent ?? [];
  return `| ${runtime} | \`${check?.authority ?? 'not_checked'}\` | ${check?.documentedCount ?? 0} | ${check?.visible?.length ?? 0} | ${check?.hiddenConfirmed?.length ?? 0} | ${check?.indeterminate?.length ?? 0} | ${absent.length > 0 ? absent.map((value) => inline(value)).join(', ') : 'none'} |`;
}).join('\n')}

### Version Drift

${renderVersionDrift(data.catalogValidity?.versionDrift)}

### Stale Or Changed Entries

Codex documented methods missing from generated schema:

${renderInlineList(data.catalogValidity?.codex?.documentedMethodsMissingFromSchema)}

Claude documented flags missing from local help and docs-only candidates:

${renderInlineList(data.catalogValidity?.claude?.documentedFlagsMissingFromHelpOrDocs)}

### Additive Update Candidates

Codex generated schema methods not yet documented:

${renderInlineList(data.catalogValidity?.codex?.schemaMethodsUndocumentedInCatalog)}

Claude local help flags not yet documented:

${renderInlineList(data.catalogValidity?.claude?.helpFlagsUndocumentedInCatalog)}

## Codex Schema Methods

${renderMethodSection(data.codex.schema?.methodEnums)}

## Codex Help Flags

${renderInlineList(data.codex.helpFlags)}

## Claude Help Flags

${renderInlineList(data.claude.helpFlags)}

## Claude Docs-Only Candidates

| Item | Source | Required probe |
| --- | --- | --- |
${(data.claude.docsOnlyCandidates ?? []).map((item) => `| ${inline(item.item)} | ${item.source} | ${escapeMarkdown(item.requiredProbe)} |`).join('\n')}

## Claude Hidden Flag Parse Probe

Flags registered with \`hideHelp()\` are absent from \`--help\`, so acceptance is measured by passing an invalid value and reading the parser's answer. \`unregistered\` means the installed CLI rejects the flag with "unknown option" and the catalog entry is stale. Controls must be \`unregistered\` for the probe to carry authority.

Authority: \`${data.catalogValidity?.claude?.hiddenFlagAuthority ?? 'not_checked'}\` — controls ${data.claude.flagProbe?.controlsOk ? 'passed' : 'FAILED (probe not trusted)'}.

| Flag | Parse probe | Strings in binary |
| --- | --- | --- |
${renderFlagProbeRows(data.claude)}

## Binary Scan Summary

Discovery-only (L0). String presence proves a token is compiled in, not that the parser accepts it — compare against the parse probe above.

| Runtime | Status | Flags | Method-like strings |
| --- | --- | ---: | ---: |
| Codex CLI | ${renderScanStatus(data.codex.binaryScan)} | ${data.codex.binaryScan?.flagCandidateCount ?? 0} | ${data.codex.binaryScan?.methodCandidateCount ?? 0} |
| Claude Code | ${renderScanStatus(data.claude.binaryScan)} | ${data.claude.binaryScan?.flagCandidateCount ?? 0} | ${data.claude.binaryScan?.methodCandidateCount ?? 0} |

## Probed Option Value Domains

Root options whose help advertises no choice list, with the domain the CLI reported when handed an argument it could not accept.

| Runtime | Option | Reported domain |
| --- | --- | --- |
${renderValueDomains(data)}

## Command Surface

Every command reachable by walking \`--help\` from the root, with the options each one advertises.

| Runtime | Commands | Options | Truncated |
| --- | ---: | ---: | --- |
| Codex CLI | ${data.codex.commandTree?.commandCount ?? 0} | ${data.codex.commandTree?.optionCount ?? 0} | ${yesNo(data.codex.commandTree?.truncated)} |
| Claude Code | ${data.claude.commandTree?.commandCount ?? 0} | ${data.claude.commandTree?.optionCount ?? 0} | ${yesNo(data.claude.commandTree?.truncated)} |

### Codex CLI

${renderCommandTree(data.codex.commandTree, 'codex')}

### Claude Code

${renderCommandTree(data.claude.commandTree, 'claude')}

## Update Guidance

1. Validate existing entries in \`${data.updateGuidance.catalog}\` before adding new entries.
2. Remove, rename, or downgrade stale entries when collected authorities no longer support them.
3. Keep source levels separate. Do not promote L0/L1/L2/L3 items into production defaults without L4 runtime probes.
4. Follow \`${data.updateGuidance.playbook}\` for LLM-assisted document updates.
`;
}

export function renderVersionDrift(items) {
  if (!items || items.length === 0) return 'None detected.';
  return ['| Runtime | Documented | Observed |', '| --- | --- | --- |']
    .concat(items.map((item) => `| ${item.runtime} | ${inline(item.documented)} | ${inline(item.observed)} |`))
    .join('\n');
}

export function renderFlagProbeRows(runtime) {
  const probe = runtime.flagProbe;
  if (!probe || probe.skipped) return '| _(probe skipped)_ | | |';
  const scanned = runtime.binaryScan?.ok === true ? runtime.binaryScan : null;
  const rows = Object.entries(probe.results ?? {});
  if (rows.length === 0) return '| _(no flags probed)_ | | |';
  return rows
    .map(([flag, verdict]) => {
      const strings = scanned
        ? yesNo((scanned.hiddenFlagsPresent ?? []).includes(flag))
        : 'unknown';
      return `| ${inline(flag)} | \`${verdict}\` | ${strings} |`;
    })
    .join('\n');
}

export function renderScanStatus(scan) {
  if (!scan) return 'not collected';
  if (scan.skipped) return 'skipped';
  if (scan.available === false) return `unavailable (${escapeMarkdown(scan.reason ?? 'unknown')})`;
  if (!scan.ok) return `failed (${escapeMarkdown(scan.reason ?? 'unknown')})`;
  return 'ok';
}

export function renderValueDomains(data) {
  const rows = [];
  for (const [label, runtime] of [['Codex CLI', data.codex], ['Claude Code', data.claude]]) {
    const domains = runtime.optionValueDomains?.domains ?? {};
    for (const [flag, domain] of Object.entries(domains)) {
      rows.push(`| ${label} | ${inline(flag)} | ${escapeMarkdown(domain)} |`);
    }
  }
  return rows.length > 0 ? rows.join('\n') : '| _(none probed)_ | | |';
}

export function renderCommandTree(tree, binaryName) {
  if (!tree || tree.skipped) return '_(command tree skipped)_';
  if (!tree.commands?.length) return 'No commands collected.';
  return tree.commands
    .map((entry) => {
      const invocation = entry.command === '(root)' ? binaryName : `${binaryName} ${entry.command}`;
      const header = `#### \`${invocation}\``;
      const usage = entry.usage ? `\nUsage: \`${entry.usage}\`\n` : '';
      const subcommands = entry.subcommands?.length
        ? `\nSubcommands: ${entry.subcommands.map((name) => inline(name)).join(', ')}\n`
        : '';
      const options = entry.options?.length
        ? [
            '',
            '| Option | Value | Choices | Default |',
            '| --- | --- | --- | --- |',
            ...entry.options.map((option) => [
              option.flags.concat(option.shortFlags).map((flag) => inline(flag)).join(', '),
              option.valuePlaceholder ? inline(option.valuePlaceholder) : '—',
              option.choices?.length ? option.choices.map((choice) => inline(choice)).join(', ') : '—',
              option.default ? inline(option.default) : '—',
            ].join(' | ')).map((row) => `| ${row} |`),
            '',
          ].join('\n')
        : '\nNo options advertised.\n';
      return `${header}\n${usage}${subcommands}${options}`;
    })
    .join('\n');
}

export function renderMethodSection(methodEnums) {
  if (!methodEnums || Object.keys(methodEnums).length === 0) return 'No Codex schema methods collected.';
  return Object.entries(methodEnums)
    .map(([name, methods]) => `### ${name}\n\n${renderInlineList(methods)}`)
    .join('\n\n');
}

export function renderInlineList(values) {
  if (!values || values.length === 0) return 'None collected.';
  return values.map((value) => `- ${inline(value)}`).join('\n');
}

export function inline(value) {
  if (!value) return '';
  return `\`${String(value).replace(/`/g, '\\`')}\``;
}

export function yesNo(value) {
  return value ? 'yes' : 'no';
}

export function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|');
}
