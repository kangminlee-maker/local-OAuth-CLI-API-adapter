/**
 * Env namespaces a spawned child must not inherit. A name is blocked when it IS
 * one of these or begins with one followed by `_` — the namespace is the unit,
 * not an exact name.
 *
 * The earlier rule was `prefix + '_' + suffix` against nine known suffixes,
 * which blocked `ANTHROPIC_API_KEY` while passing `ANTHROPIC_CUSTOM_HEADERS`,
 * `AWS_ACCESS_KEY_ID`, `AWS_BEARER_TOKEN_BEDROCK` and
 * `GOOGLE_APPLICATION_CREDENTIALS` — all of them read by the installed CLIs
 * (probed against Claude Code 2.1.237 and codex 0.146.0, whose SDKs resolve the
 * whole AWS and Azure credential chains). A list of names cannot hold that
 * boundary: every provider release adds more of them.
 */
const DIRECT_PROVIDER_ENV_NAMESPACES = [
  'ANTHROPIC',
  'AWS',
  'AZURE',
  'BEDROCK',
  'COHERE',
  'DEEPSEEK',
  'GEMINI',
  'GOOGLE',
  'GROQ',
  'MISTRAL',
  'OPENAI',
  'OPENROUTER',
  'PERPLEXITY',
  'TOGETHER',
  'VERTEX',
  'XAI',
  // Not provider names, but they put a child ON one of the providers above,
  // with the credentials above: `CLAUDE_CODE_USE_BEDROCK` and its siblings
  // select an execution route, and the route is the adapter's to choose.
  'CLAUDE_CODE_USE',
  // A key handed over by file descriptor is the same credential by another
  // channel.
  'CLAUDE_CODE_API_KEY',
] as const;

/**
 * The child's own local-session env is deliberately NOT in that list —
 * `CODEX_*` and the rest of `CLAUDE_CODE_*` are the local OAuth path this proxy
 * runs on, not a direct provider path. Nor are the operator's suppression flags
 * (`CLAUDE_CODE_SKIP_*`, `CLAUDE_CODE_DISABLE_*`): stripping a negative flag
 * turns the behaviour it suppresses back ON, so a blanket sweep of those would
 * silently re-enable what the operator switched off.
 */
export function proxyChildProcessEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isDirectProviderEnvName(key)) continue;
    env[key] = value;
  }
  env.TERM = process.env.TERM && process.env.TERM !== 'dumb'
    ? process.env.TERM
    : 'xterm-256color';
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function isDirectProviderEnvName(name: string): boolean {
  return DIRECT_PROVIDER_ENV_NAMESPACES.some((namespace) => (
    name === namespace || name.startsWith(`${namespace}_`)
  ));
}
