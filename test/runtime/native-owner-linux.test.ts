import { expect, test } from 'bun:test';
import { durableProcessOwner, proveDurableOwnerDrained } from '../../deploy/runtime/process-owner';

test.skipIf(process.platform !== 'linux')('kernel proof rejects a surviving writer and accepts only after its group drains', async () => {
  const child = Bun.spawn(['/bin/sh', '-c', 'cat >/dev/null; sleep 30 & wait'], { detached: true, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' });
  const { owner, fence } = durableProcessOwner(child);
  child.stdin.write('fixture'); child.stdin.end();
  try {
    await expect(proveDurableOwnerDrained(fence)).rejects.toThrow('Child process group did not drain');
    await owner.stop();
    await proveDurableOwnerDrained(fence);
    await expect(proveDurableOwnerDrained({ boot: fence.boot, identity: { pid: process.pid, group: process.pid, session: process.pid, birth: '1' } })).rejects.toThrow('Child process identity changed');
  } finally { await owner.stop(); }
}, 45_000);
