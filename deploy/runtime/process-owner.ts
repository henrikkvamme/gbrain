import { readFileSync, readdirSync } from 'node:fs';

export type ProcessIdentity = { pid: number; group: number; session: number; birth: string };

export function parseProcessIdentity(stat: string): ProcessIdentity {
  // comm may contain spaces and parentheses. Fields after its final ')' start
  // at field 3; starttime is field 22 and survives parent exit/PID reuse.
  const end = stat.lastIndexOf(')');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const identity = { pid: Number(stat.slice(0, stat.indexOf(' '))), group: Number(fields[2]), session: Number(fields[3]), birth: fields[19] };
  if (end < 0 || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
      !Number.isSafeInteger(identity.group) || !Number.isSafeInteger(identity.session) ||
      !/^\d+$/.test(identity.birth ?? '')) throw new Error('Cannot verify child process identity');
  return identity;
}

export function readIdentity(pid: number): ProcessIdentity | undefined {
  try { return parseProcessIdentity(readFileSync(`/proc/${pid}/stat`, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    throw error;
  }
}

export function ownedGroup(owner: ProcessIdentity, processes: ProcessIdentity[]): ProcessIdentity[] {
  const leader = processes.find(p => p.pid === owner.pid);
  const members = processes.filter(p => p.group === owner.group);
  // The group ID cannot be recycled while any member remains. Never signal a
  // new leader or a group whose session/birth no longer matches our child.
  if (leader && leader.birth !== owner.birth || members.some(p => p.session !== owner.session || BigInt(p.birth) < BigInt(owner.birth))) {
    throw new Error('Child process identity changed');
  }
  return members;
}

/** Linux-only owner of a detached child group, including orphaned descendants. */
export function processOwner(child: ReturnType<typeof Bun.spawn>) {
  // Capture once at birth, never adopt a PID found during a cleanup retry.
  let owner: ProcessIdentity | undefined;
  let captureError: unknown;
  try {
    owner = readIdentity(child.pid);
    if (!owner || owner.group !== child.pid || owner.session !== child.pid) throw new Error('Cannot verify child process identity');
  } catch (error) { captureError = error; }
  const members = () => {
    if (captureError) throw captureError;
    if (!owner) throw new Error('Cannot verify child process identity');
    const processes: ProcessIdentity[] = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const identity = readIdentity(Number(entry));
      if (identity) processes.push(identity);
    }
    return ownedGroup(owner, processes);
  };
  const signal = (value: NodeJS.Signals) => {
    if (!members().length) return;
    try { process.kill(-child.pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const groupExists = () => {
    try { process.kill(-child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  return {
    identity: owner,
    exited: child.exited,
    async stop() {
      signal('SIGTERM');
      const graceful = Date.now() + 30_000;
      const deadline = graceful + 10_000;
      while (true) {
        members(); // Inspection failures and identity mismatches stay fail-closed.
        if (!groupExists()) {
          await child.exited;
          if (!groupExists()) return;
        }
        // An empty /proc snapshot is not proof of absence: a process can fork
        // and exit between enumeration and stat. Rescan rather than adopt or
        // signal an unverified group; only kernel ESRCH releases ownership.
        // Sweep descendants promptly once the parent exits.
        if (child.exitCode !== null || Date.now() >= graceful) signal('SIGKILL');
        if (Date.now() >= deadline) throw new Error('Child process group did not drain');
        await Bun.sleep(20);
      }
    },
  };
}

export function durableProcessOwner(child: ReturnType<typeof Bun.spawn>) {
  const owner = processOwner(child);
  if (!owner.identity) throw new Error('Cannot verify child process identity');
  return { owner, fence: { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), identity: owner.identity } };
}

/** Restart proof only. Never adopt or kill an ambiguous or reused PID. */
export async function proveDurableOwnerDrained(value: unknown) {
  const fence = value as { boot?: string; identity?: ProcessIdentity } | undefined;
  if (!fence?.boot || !fence.identity || !/^\d+$/.test(fence.identity.birth)) throw new Error('Cannot verify child process identity');
  if (fence.boot !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()) return;
  const owner = fence.identity;
  if (owner.pid <= 0 || owner.group !== owner.pid || owner.session !== owner.pid) throw new Error('Cannot verify child process identity');
  const processes = readdirSync('/proc').filter(p => /^\d+$/.test(p)).flatMap(p => { const id = readIdentity(Number(p)); return id ? [id] : []; });
  ownedGroup(owner, processes); // Reused leaders/sessions are never signaled.
  try { process.kill(-owner.group, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
  // A surviving group keeps startup fenced. Root may stop the exact old container,
  // then restart. A fresh runtime never opens the engine under a surviving owner.
  throw new Error('Child process group did not drain');
}
