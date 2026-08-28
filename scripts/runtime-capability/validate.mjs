// Compares what the catalog claims against what was collected. Produces the
// stale set, the additive candidates, and the reasons a run is inconclusive.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { catalogPath, skipFlagProbe } from './options.mjs';
import {
  commandInventoryCells,
  documentedCommandPaths,
  documentedFlagUses,
  documentedOptionDomains,
  documentedRequestContracts,
  normalizeDomainValue,
} from './catalog-doc.mjs';
import { rootOptionsOf } from './help-parser.mjs';
import { commandAnswersForItself, commandUsage, probeFlagControls, probeFlagInCommand } from './probes.mjs';
import {
  difference,
  extractVersionCell,
  firstLine,
  intersection,
  normalizeVersion,
  sectionBetween,
  uniqueCapture,
  uniqueMatches,
  uniqueSorted,
} from './text.mjs';

export async function validateCatalog(data) {
  if (!existsSync(catalogPath)) {
    return {
      exists: false,
      verdict: 'missing_catalog',
      staleCount: 0,
      updateCandidateCount: 0,
    };
  }

  const text = await readFile(catalogPath, 'utf8');
  const codexSection = sectionBetween(text, '## Codex capability list', '## Claude Code capability list');
  const claudeSection = sectionBetween(text, '## Claude Code capability list', '## Service chat runtime output list');
  const schemaMethods = uniqueSorted(Object.values(data.codex.schema?.methodEnums ?? {}).flat());
  const documentedCodexMethods = uniqueCapture(codexSection, /`([A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)+)`/g);
  const documentedClaudeFlags = uniqueMatches(claudeSection, /--[A-Za-z0-9][A-Za-z0-9_-]+/g);
  // hideHelp() flags are allowed only when the parse probe shows the installed CLI
  // still accepts them. The binary scan is not sufficient authority here: a release
  // can keep a flag's strings while removing it from the parser, which reads as
  // "present" to a string scan and "unknown option" to the user. The probe is only
  // trusted when its negative controls came back unregistered; otherwise there is no
  // authority and the declared list is used, so a reduced-authority run does not
  // manufacture a stale signal. Whichever path is taken is reported as
  // `hiddenFlagAuthority` so a degraded run cannot read as a verified one.
  const probe = data.claude.flagProbe;
  const probeIsAuthoritative = Boolean(probe && !probe.skipped && probe.controlsOk);
  const declaredHiddenFlags = [
    ...(data.claude.hiddenProbedFlags ?? []).map((item) => item.item),
    ...(data.claude.hiddenL0CandidateFlags ?? []),
  ];
  const declaredDocsOnlyFlags = (data.claude.docsOnlyCandidates ?? []).map((item) => item.item);
  const acceptedHiddenFlags = probeIsAuthoritative
    ? probe.registered
    : [...declaredHiddenFlags, ...declaredDocsOnlyFlags];
  const claudeAllowedFlags = uniqueSorted([
    ...(data.claude.helpFlags ?? []),
    ...acceptedHiddenFlags,
  ]);

  const documentedVersions = {
    codex: extractVersionCell(text, 'Codex CLI'),
    claude: extractVersionCell(text, 'Claude Code'),
  };
  const observedVersions = {
    codex: firstLine(data.codex.version?.stdout),
    claude: firstLine(data.claude.version?.stdout),
  };

  const versionDrift = [];
  for (const runtime of ['codex', 'claude']) {
    const documented = documentedVersions[runtime];
    const observed = observedVersions[runtime];
    if (documented && observed && normalizeVersion(documented) !== normalizeVersion(observed)) {
      versionDrift.push({ runtime, documented, observed });
    }
  }

  const documentedCodexMethodMissingFromSchema = difference(documentedCodexMethods, schemaMethods);
  const schemaCodexMethodUndocumented = difference(schemaMethods, documentedCodexMethods);
  const documentedClaudeFlagMissingFromHelpOrDocs = difference(documentedClaudeFlags, claudeAllowedFlags);
  const claudeHelpFlagUndocumented = difference(data.claude.helpFlags ?? [], documentedClaudeFlags);

  const codexCommands = await validateDocumentedCommands(data.codex, codexSection, 'codex');
  const claudeCommands = await validateDocumentedCommands(data.claude, claudeSection, 'claude');
  const codexFlags = await validateDocumentedFlagUses(data.codex, codexSection, 'codex');
  const requestContracts = validateDocumentedRequestContracts(data.codex, codexSection);
  const undocumentedOptions = {
    codex: undocumentedTreeOptions(data.codex, codexSection),
    claude: undocumentedTreeOptions(data.claude, claudeSection),
  };

  const codexDomains = validateDocumentedOptionDomains(data.codex, codexSection);
  const claudeDomains = validateDocumentedOptionDomains(data.claude, claudeSection);
  const optionDomains = [...codexDomains.mismatches, ...claudeDomains.mismatches];
  const unverifiedDomains = [...codexDomains.unverified, ...claudeDomains.unverified];

  const staleCount = codexCommands.absent.length
    + claudeCommands.absent.length
    + codexFlags.absent.length
    + requestContracts.mismatches.length
    + optionDomains.length
    + versionDrift.length
    + documentedCodexMethodMissingFromSchema.length
    + documentedClaudeFlagMissingFromHelpOrDocs.length;
  // Options discovered anywhere in the walked tree count as additive candidates.
  // The claude help-flag term is a subset of its tree options, so counting both
  // would double-report the same drift.
  const updateCandidateCount = schemaCodexMethodUndocumented.length
    + codexCommands.undocumented.length
    + claudeCommands.undocumented.length
    + undocumentedOptions.codex.length
    + undocumentedOptions.claude.length;

  // A run that could not check something must not read as a run that checked it
  // and found nothing. Without this, skipping the probe or losing its controls
  // makes every declared hidden flag "supported", drives stale to zero, and lets
  // the verdict claim validity the run never established.
  const inconclusiveReasons = [];

  // The same rule, one level earlier. Every check below compares a documented
  // set against a collected one, so an empty documented set makes each
  // difference() empty, each count zero, and the verdict clean — which is
  // indistinguishable from a run that checked everything and found nothing. The
  // ordinary way it happens is a renamed heading or a reformatted version row,
  // and this catalog's own update rules actively invite both: they tell the
  // operator to restructure the document. Assert the parse before trusting what
  // it produced.
  if (!codexSection) {
    inconclusiveReasons.push('catalog heading "## Codex capability list" not found: codex expectations parsed empty');
  } else if (documentedCodexMethods.length === 0) {
    inconclusiveReasons.push('codex capability section parsed to zero documented methods');
  }
  if (!claudeSection) {
    inconclusiveReasons.push('catalog heading "## Claude Code capability list" not found: claude expectations parsed empty');
  } else if (documentedClaudeFlags.length === 0) {
    inconclusiveReasons.push('claude capability section parsed to zero documented flags');
  }
  // Section-wide non-emptiness is not enough: each of these parsers reads its own
  // table with its own heading, and any one of them can return an empty list
  // while the surrounding section is full. Its validator then iterates zero
  // times, its stale set is empty, and the verdict is clean over claims nobody
  // checked. Populations on this machine are 66/33 commands, 14 codex flag uses,
  // 2 request contracts and 10 option domains, so zero means the parse broke.
  const parsedPopulations = [
    ['codex commands', codexCommands.documentedCount],
    ['claude commands', claudeCommands.documentedCount],
    ['codex flag uses', codexFlags.count],
    ['codex request contracts', requestContracts.documentedCount],
    ['documented option domains', (codexDomains.documentedCount ?? 0) + (claudeDomains.documentedCount ?? 0)],
  ];
  for (const [label, count] of parsedPopulations) {
    if (!count) {
      inconclusiveReasons.push(`${label} parsed to zero entries: that table's claims went unchecked`);
    }
  }
  // #3: an authority the operator switched off is not an authority that passed.
  // `--skip-flag-probe` already reports itself this way; the binary scan did not.
  for (const runtime of ['claude']) {
    const scan = data[runtime]?.binaryScan;
    const declaredL0 = (data[runtime]?.hiddenL0CandidateFlags ?? []).length;
    if (declaredL0 > 0 && (!scan || scan.skipped || !scan.available || !scan.ok)) {
      inconclusiveReasons.push(`${runtime} binary scan did not run, so its ${declaredL0} L0-only candidates went unchecked`);
    }
  }
  for (const runtime of ['codex', 'claude']) {
    if (!documentedVersions[runtime]) {
      inconclusiveReasons.push(`${runtime} version cell not found in the catalog table: version drift unchecked`);
    }
    if (!observedVersions[runtime]) {
      inconclusiveReasons.push(`${runtime} version not observed from the binary: version drift unchecked`);
    }
  }
  if (!probeIsAuthoritative) {
    inconclusiveReasons.push(probe?.skipped
      ? 'hidden flag parse probe skipped'
      : 'hidden flag parse probe controls did not come back unregistered');
  }
  if ((probe?.indeterminate?.length ?? 0) > 0) {
    inconclusiveReasons.push(`indeterminate flag probes: ${probe.indeterminate.join(', ')}`);
  }
  if ((codexFlags.unprobed ?? []).length > 0) {
    inconclusiveReasons.push(`codex options left unprobed: ${codexFlags.unprobed.join(', ')}`);
  }
  if (codexFlags.indeterminate.length > 0) {
    inconclusiveReasons.push(`indeterminate codex option probes: ${codexFlags.indeterminate.join(', ')}`);
  }
  if ((codexFlags.controlsFailed ?? []).length > 0) {
    inconclusiveReasons.push(`codex option probe controls did not come back unregistered for: ${codexFlags.controlsFailed.join(', ')}`);
  }
  for (const [runtime, check] of [['codex', codexCommands], ['claude', claudeCommands]]) {
    if ((check.indeterminate ?? []).length > 0) {
      inconclusiveReasons.push(`${runtime} command probes could not tell: ${check.indeterminate.join(', ')}`);
    }
  }
  // The collector states that a dropped L0 candidate should surface here. It
  // computed the set and nothing read it, so the assertion in that comment was
  // never true. A missing string is not staleness on its own — the scan is noisy
  // and L0 is candidates only — but it is authority the run did not get.
  //
  // This covers claude only, and by design rather than by omission: `collectClaude`
  // is the caller that passes a declared candidate list to `collectBinaryScan`,
  // because those flags are hidden from every help surface AND cannot be probed
  // positively — the CLI tolerates unknown options there. Codex's hidden options
  // are probeable, so `codexOptionUses` is their authority and it is a stronger
  // one; a candidate list for codex would add a noisier check over the same
  // ground. Reading `hiddenFlagsMissing` for a runtime that declared no
  // candidates would be a check over an empty set, which is the shape this whole
  // pass exists to remove.
  for (const [runtime, scan] of [['claude', data.claude?.binaryScan]]) {
    if (!scan?.available || !scan.ok) continue;
    const declared = (scan.hiddenFlagsPresent ?? []).length + (scan.hiddenFlagsMissing ?? []).length;
    if (declared === 0) {
      inconclusiveReasons.push(`${runtime} binary scan ran with no declared hidden-flag candidates to check`);
      continue;
    }
    // The scan is handed every probed flag, not only the L0 candidates, so the
    // report can answer "is this string in the binary" for all of them. Only the
    // L0-only ones carry authority here: a parser-confirmed or docs-listed flag
    // missing from a deliberately noisy string scan says nothing, and treating
    // it as lost authority would block healthy runs.
    const l0Candidates = new Set(data[runtime]?.hiddenL0CandidateFlags ?? []);
    const lostL0 = scan.hiddenFlagsMissing.filter((flag) => l0Candidates.has(flag));
    if (lostL0.length > 0) {
      inconclusiveReasons.push(`${runtime} binary scan no longer finds declared L0-only hidden-flag candidates: ${lostL0.join(', ')}`);
    }
  }
  if (requestContracts.unverified.length > 0) {
    inconclusiveReasons.push(`request contracts not verified: ${requestContracts.unverified.map((entry) => `${entry.method} (${entry.reason})`).join(', ')}`);
  }
  if (unverifiedDomains.length > 0) {
    inconclusiveReasons.push(`documented value domains not verified: ${unverifiedDomains.map((entry) => `${entry.runtime} ${entry.flag} (${entry.reason})`).join(', ')}`);
  }
  for (const [runtime, check] of [['codex', codexCommands], ['claude', claudeCommands]]) {
    if (check.authority === 'not_collected' && check.documentedCount > 0) {
      inconclusiveReasons.push(`${runtime} command surface not collected`);
    }
    // A walk that stopped at a cap inspected only part of the surface, so it
    // cannot support a "nothing changed" verdict for the part it never saw.
    if (data[runtime]?.commandTree?.truncated) {
      inconclusiveReasons.push(`${runtime} command walk truncated at the collection cap`);
    }
    if ((check.failedHelp ?? []).length > 0) {
      inconclusiveReasons.push(`${runtime} help failed for: ${check.failedHelp.join(', ')}`);
    }
  }
  const inconclusive = inconclusiveReasons.length > 0;

  return {
    exists: true,
    verdict: staleCount > 0
      ? 'needs_update'
      : (inconclusive ? 'inconclusive_reduced_authority' : 'valid_against_collected_authorities'),
    inconclusive,
    inconclusiveReasons,
    staleCount,
    updateCandidateCount,
    versionDrift,
    commands: {
      codex: codexCommands,
      claude: claudeCommands,
    },
    codexOptionUses: codexFlags,
    requestContractMismatches: requestContracts.mismatches,
    undocumentedOptions: {
      codex: undocumentedOptions.codex.slice(0, 40),
      claude: undocumentedOptions.claude.slice(0, 40),
      codexCount: undocumentedOptions.codex.length,
      claudeCount: undocumentedOptions.claude.length,
    },
    optionDomainMismatches: optionDomains,
    optionDomainsUnverified: unverifiedDomains,
    codex: {
      documentedMethodCount: documentedCodexMethods.length,
      schemaMethodCount: schemaMethods.length,
      documentedMethodsStillInSchema: intersection(documentedCodexMethods, schemaMethods),
      documentedMethodsMissingFromSchema: documentedCodexMethodMissingFromSchema,
      schemaMethodsUndocumentedInCatalog: schemaCodexMethodUndocumented,
    },
    claude: {
      documentedFlagCount: documentedClaudeFlags.length,
      localHelpFlagCount: data.claude.helpFlags?.length ?? 0,
      hiddenFlagAuthority: probeIsAuthoritative ? 'parse_probe' : 'declared_fallback',
      hiddenFlagsRejectedByParser: probeIsAuthoritative ? probe.unregistered : [],
      documentedFlagsStillSupportedOrDocsOnly: intersection(documentedClaudeFlags, claudeAllowedFlags),
      documentedFlagsMissingFromHelpOrDocs: documentedClaudeFlagMissingFromHelpOrDocs,
      helpFlagsUndocumentedInCatalog: claudeHelpFlagUndocumented,
    },
  };
}

// The command tree is only an authority if the validity check consumes it.
// Every command the catalog names is required to be either in the walked tree
// or, for the documented hidden ones, to answer `--help` for itself; anything
// else is a catalog entry the installed CLI no longer has.
export async function validateDocumentedCommands(runtime, section, binaryName) {
  const documented = documentedCommandPaths(section, binaryName);
  const tree = runtime.commandTree;
  if (!runtime.binary || !tree || tree.skipped) {
    return {
      authority: 'not_collected',
      documentedCount: documented.length,
      visible: [],
      hiddenConfirmed: [],
      absent: [],
      undocumented: [],
      failedHelp: [],
    };
  }
  // A help invocation that failed may still have printed something parseable.
  // Counting it as proof the command exists would let a partial or errored walk
  // certify the catalog, so those entries are excluded from the evidence set and
  // reported instead.
  const failedHelp = (tree.commands ?? []).filter((entry) => entry.ok === false).map((entry) => entry.command);
  const collected = (tree.commands ?? []).filter((entry) => entry.ok !== false);
  const known = new Set(collected.map((entry) => entry.command));
  const usageOf = new Map(collected.map((entry) => [entry.command, entry.usage]));
  const visible = documented.filter((command) => known.has(command));
  const hiddenConfirmed = [];
  const absent = [];
  const indeterminateCommands = [];
  for (const command of documented.filter((entry) => !known.has(entry))) {
    const parent = command.split(' ').slice(0, -1).join(' ');
    // The parent of a hidden command is often hidden too, so it is absent from
    // the tree. Falling back to the root usage there would accept a removed
    // child whose invocation lands on its still-present parent's help, since
    // that help differs from the root's. Probe the real parent instead.
    const parentKey = parent || '(root)';
    if (!usageOf.has(parentKey)) {
      usageOf.set(parentKey, await commandUsage(runtime.binary, parent));
    }
    const parentUsage = usageOf.get(parentKey);
    const answer = await commandAnswersForItself(runtime.binary, binaryName, command, parentUsage);
    if (answer === 'yes') hiddenConfirmed.push(command);
    else if (answer === 'indeterminate') indeterminateCommands.push(command);
    else absent.push(command);
  }
  // Commands the installed CLI has but the catalog never mentions are additive
  // candidates: not stale, but the only signal that the surface grew.
  const documentedSet = new Set(documented);
  const undocumented = (tree.commands ?? [])
    .map((entry) => entry.command)
    .filter((command) => command !== '(root)' && !documentedSet.has(command));
  return {
    authority: 'command_tree_plus_probe',
    indeterminate: indeterminateCommands,
    documentedCount: documented.length,
    visible,
    hiddenConfirmed,
    absent,
    undocumented,
    failedHelp,
  };
}

// The catalog's request parameter table is the authority the adapter relies on
// when it sends only declared fields. Compare it with the generated schema so a
// changed contract shows up here instead of in a silent runtime behaviour change.
export function validateDocumentedRequestContracts(codex, section) {
  const contracts = codex.schema?.requestContracts ?? {};
  const mismatches = [];
  const unverified = [];
  let documentedCount = 0;
  for (const [method, documented] of documentedRequestContracts(section)) {
    documentedCount += 1;
    const observed = contracts[method];
    if (!observed) {
      unverified.push({ method, reason: 'no schema contract collected' });
      continue;
    }
    const diff = (documentedList, observedList) => ({
      documentedButAbsent: documentedList.filter((name) => !observedList.includes(name)),
      presentButUndocumented: observedList.filter((name) => !documentedList.includes(name)),
    });
    const required = diff(documented.required, observed.required);
    const optional = diff(documented.optional, observed.optional);
    if (required.documentedButAbsent.length || required.presentButUndocumented.length
      || optional.documentedButAbsent.length || optional.presentButUndocumented.length) {
      mismatches.push({ method, required, optional });
    }
  }
  return { mismatches, unverified, documentedCount };
}

// Documented options need a presence authority too. The claude flags have one
// through help plus the parse probe; codex options had none, so removing a
// documented option such as `codex exec --ephemeral` left every stale term at
// zero. Each documented use is checked in the command it is documented under,
// since an option only exists relative to its command.
export async function validateDocumentedFlagUses(runtime, section, binaryName) {
  const uses = documentedFlagUses(section, binaryName);
  const tree = runtime.commandTree;
  if (!runtime.binary || !tree || tree.skipped) {
    return { authority: 'not_collected', count: uses.length, visible: [], hiddenConfirmed: [], absent: [], indeterminate: [], unprobed: [] };
  }
  const optionsOf = new Map((tree.commands ?? [])
    .filter((entry) => entry.ok !== false)
    .map((entry) => [entry.command, new Set((entry.options ?? []).flatMap((option) => option.flags))]));
  const visible = [];
  const hiddenConfirmed = [];
  const absent = [];
  const indeterminate = [];
  const unprobed = [];
  const controlsByCommand = new Map();
  const controlsFailed = new Set();
  for (const use of uses) {
    const key = use.command || '(root)';
    const label = `${use.command} ${use.flag}`.trim();
    if (optionsOf.get(key)?.has(use.flag)) {
      visible.push(label);
      continue;
    }
    // `--skip-flag-probe` opts out of launching the CLI. Honouring it here means
    // the hidden options go unchecked, which is reported rather than assumed.
    if (skipFlagProbe) {
      unprobed.push(label);
      continue;
    }
    // Controls first, once per command: without them a reworded rejection makes
    // every probe below read as confirmed.
    if (!controlsByCommand.has(key)) {
      controlsByCommand.set(key, await probeFlagControls(runtime.binary, use.command));
    }
    if (!controlsByCommand.get(key).ok) {
      controlsFailed.add(key);
      indeterminate.push(label);
      continue;
    }
    const verdict = await probeFlagInCommand(runtime.binary, use.command, use.flag);
    if (verdict === 'unregistered') absent.push(label);
    else if (verdict === 'indeterminate') indeterminate.push(label);
    else hiddenConfirmed.push(label);
  }
  return {
    authority: skipFlagProbe ? 'command_tree_only' : 'command_tree_plus_probe',
    controlsFailed: [...controlsFailed],
    count: uses.length,
    visible,
    hiddenConfirmed,
    absent,
    indeterminate,
    unprobed,
  };
}

// The catalog states value domains for options. Collected evidence — help
// choice lists and probe replies — is compared against them, so a CLI that
// changes an accepted value set makes the catalog stale instead of quietly
// disagreeing with it. Only enumerable domains are compared; prose like
// "a positive number greater than 0" describes no value set.
export function validateDocumentedOptionDomains(runtime, section) {
  const observed = collectedOptionDomains(runtime);
  const probe = runtime.optionValueDomains ?? {};
  const unresolved = new Set(probe.unresolved ?? []);
  const mismatches = [];
  const unverified = [];
  let documentedCount = 0;
  for (const [flag, documented] of documentedOptionDomains(section)) {
    documentedCount += 1;
    const collected = observed.get(flag);
    if (!collected || collected.size === 0) {
      // A documented domain with no evidence went unchecked, whatever the
      // reason. Restricting this to probe targets would let a flag whose help
      // stopped enumerating its choices keep its old documented domain: no
      // collected values, not a probe target, and therefore silently accepted.
      unverified.push({
        runtime: runtime.name,
        flag,
        reason: probe.skipped
          ? 'probe skipped'
          : (unresolved.has(flag) ? 'probe returned no domain' : 'no help choices and not probed'),
      });
      continue;
    }
    const missing = [...documented].filter((value) => !collected.has(value));
    const unexpected = [...collected].filter((value) => !documented.has(value));
    if (missing.length > 0 || unexpected.length > 0) {
      mismatches.push({
        runtime: runtime.name,
        flag,
        documented: [...documented],
        observed: [...collected],
        documentedButNotAccepted: missing,
        acceptedButNotDocumented: unexpected,
      });
    }
  }
  return { mismatches, unverified, documentedCount };
}

export function collectedOptionDomains(runtime) {
  const domains = new Map();
  for (const option of rootOptionsOf(runtime.commandTree)) {
    if (!option.choices?.length) continue;
    const values = new Set(option.choices.map(normalizeDomainValue).filter(Boolean));
    for (const flag of option.flags) domains.set(flag, values);
  }
  for (const [flag, domain] of Object.entries(runtime.optionValueDomains?.domains ?? {})) {
    const values = String(domain).split(',').map(normalizeDomainValue).filter(Boolean);
    if (values.length > 1) domains.set(flag, new Set(values));
  }
  return domains;
}

// Options the installed CLI advertises anywhere in the tree but the catalog
// never mentions. Additive candidates, not staleness.
export function undocumentedTreeOptions(runtime, section) {
  const mentioned = new Set(uniqueMatches(section, /--[A-Za-z0-9][A-Za-z0-9_-]*/g));
  const flags = new Set();
  for (const command of runtime.commandTree?.commands ?? []) {
    for (const option of command.options ?? []) {
      for (const flag of option.flags) {
        if (flag !== '--help' && flag !== '--version' && !mentioned.has(flag)) flags.add(flag);
      }
    }
  }
  return [...flags].sort();
}
