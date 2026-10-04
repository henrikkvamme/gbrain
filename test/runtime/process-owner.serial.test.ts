import { expect, test } from 'bun:test';

// Module mocks stay in a disposable subprocess, never in the caller's registry.
test('does not release ownership when a descendant forks between proc enumeration and stat', async () => {
  const program = `
    import { spyOn } from 'bun:test';
    import * as fs from 'node:fs';
    const stat = (pid, birth) => pid + ' (fixture) ' + ['S','1','100','100',...Array(15).fill('0'),birth].join(' ');
    let scans = 0;
    let live = true;
    let killed = false;
    let probes = 0;
    const missing = () => Object.assign(new Error('gone'), {code:'ENOENT'});
    spyOn(fs, 'readFileSync').mockImplementation(path => {
        if (path === '/proc/100/stat') return stat(100, '500');
        if (path === '/proc/101/stat') throw missing(); // forked 102, then exited
        if (path === '/proc/102/stat' && live) return stat(102, '501');
        throw missing();
    });
    spyOn(fs, 'readdirSync').mockImplementation(() => ++scans <= 2 ? ['101'] : live ? ['102'] : []);
    process.kill = (pid, signal) => {
      if (pid !== -100) throw new Error('Signalled a foreign group');
      if (signal === 0) {
        probes++;
        if (!live) throw Object.assign(new Error('gone'), {code:'ESRCH'});
      } else { killed = true; live = false; }
      return true;
    };
    const { processOwner } = await import('./deploy/runtime/process-owner.ts');
    const owner = processOwner({pid:100, exited:Promise.resolve(0), exitCode:0});
    await owner.stop();
    if (live || !killed || probes === 0) throw new Error('Released ownership with surviving forked writer');
  `;
  const child = Bun.spawn(['bun', '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  });
  const output = await new Response(child.stderr).text();
  expect({ rc: await child.exited, output }).toEqual({ rc: 0, output: '' });
});
