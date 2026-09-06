import type { ChildProcess } from 'node:child_process';

/** How long a child gets to leave after each signal — `SIGTERM`, then `SIGKILL`. */
export const CHILD_EXIT_GRACE_MS = 1_000;

export interface ChildExit {
  readonly exited: boolean;
  readonly pid: number | undefined;
}

/**
 * Ends a child this process spawned and returns once it has exited: `SIGTERM`,
 * the grace, `SIGKILL` to the same handle, the grace again. Only the handle is
 * signalled — never a name, never a group. Never rejects: a child still there
 * after the second grace is reported, not waited for (it is in a kernel wait
 * the signal will end). Both native runtimes end their children through this
 * one rule (t1 B-child gap 6: each forgot the handle at the `SIGTERM`, so a
 * child that ignored it outlived a close reported as success, and its
 * credentials copy was removed while it still ran).
 */
export async function terminateChild(child: ChildProcess, graceMs = CHILD_EXIT_GRACE_MS): Promise<ChildExit> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return { exited: true, pid };
  const exited = new Promise<boolean>((resolve) => {
    child.once('exit', () => resolve(true));
  });
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    child.kill(signal);
    if (await Promise.race([exited, grace(graceMs)])) return { exited: true, pid };
  }
  return { exited: false, pid };
}

/** A wait that never keeps the process alive on its own. */
function grace(ms: number): Promise<false> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(false), ms).unref();
  });
}
