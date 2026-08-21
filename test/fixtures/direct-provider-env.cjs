// The runtime's env rule, in the one form a spawned fake child can read.
//
// The fakes assert the isolation boundary from INSIDE a child, which is the
// only place that can prove it, so their classifier has to say what
// `src/proxy/process-env.ts` says. It used to be copied by hand into each fake,
// and when the runtime moved from exact names to whole namespaces the copies
// stayed behind — asserting a boundary the product no longer draws.
// `test/process-env.test.mjs` compares this rule against the built one, so a
// future divergence fails a test instead of quietly weakening every fake.
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
  'CLAUDE_CODE_USE',
  'CLAUDE_CODE_API_KEY',
];

function isDirectProviderEnvName(name) {
  return DIRECT_PROVIDER_ENV_NAMESPACES.some(
    (namespace) => name === namespace || name.startsWith(`${namespace}_`),
  );
}

/** Exits 91 — a code no fake uses for anything else — when the boundary leaked. */
function assertNoDirectProviderEnv(label) {
  if (process.env.FAKE_ASSERT_NO_DIRECT_PROVIDER_ENV !== '1') return;
  const found = Object.keys(process.env).filter(isDirectProviderEnvName);
  if (found.length > 0) {
    process.stderr.write(`direct provider env leaked to ${label}: ${found.join(',')}\n`);
    process.exit(91);
  }
}

module.exports = {
  DIRECT_PROVIDER_ENV_NAMESPACES,
  isDirectProviderEnvName,
  assertNoDirectProviderEnv,
};
