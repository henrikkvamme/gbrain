import { describe, expect, test } from 'bun:test';
import { ownedGroup, parseProcessIdentity, type ProcessIdentity } from '../../deploy/runtime/process-owner';

const owner: ProcessIdentity = { pid: 100, group: 100, session: 100, birth: '500' };

describe('Linux runtime process identity', () => {
  test('parses birth after a command name containing spaces and parentheses', () => {
    const fields = ['S', '1', '100', '100', ...Array(15).fill('0'), '500'];
    expect(parseProcessIdentity(`100 (fixture (child)) ${fields.join(' ')}`)).toEqual(owner);
    expect(() => parseProcessIdentity('invalid')).toThrow('Cannot verify');
  });

  test('retains descendants after parent exit and accepts verified group absence', () => {
    const descendant = { ...owner, pid: 101, birth: '501' };
    expect(ownedGroup(owner, [descendant])).toEqual([descendant]);
    expect(ownedGroup(owner, [])).toEqual([]);
  });

  test('refuses a recycled parent PID or a foreign session before signalling', () => {
    expect(() => ownedGroup(owner, [{ ...owner, birth: '700' }])).toThrow('identity changed');
    expect(() => ownedGroup(owner, [{ ...owner, pid: 101, session: 200 }])).toThrow('identity changed');
    expect(() => ownedGroup(owner, [{ ...owner, pid: 101, birth: '499' }])).toThrow('identity changed');
  });
});
