// Loaded with `--import` into a runner that a test starts in plan mode. Plan mode
// makes no call; this makes "no call" a property of the process rather than of a
// flag the test remembered to leave out.
globalThis.fetch = async () => {
  process.stderr.write('refuse-network: a process started by a test tried to reach the network\n');
  process.exit(97);
};
