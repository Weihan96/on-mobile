import { test, expect } from 'bun:test';
import { applyOriginUpdate, originAllowsTunnel, MAINTENANCE_MS } from '../scripts/lib/origin-update.mjs';
function scenario() {
  let time = Date.now(), stopped = false, current = 'old'; const calls = [];
  const service = { workerPid: 123, expiresAt: new Date(time + 120000).toISOString() };
  const previous = { active: { name: 'old', readyPath: '/old-health' }, previous: { name: 'older', readyPath: '/' } };
  const request = { id: 'fixture', candidate: { name: 'new' }, readyPath: '/new-health' };
  const ops = { now: () => time, sleep: async ms => { time += ms; }, stopping: async () => stopped,
    begin: async m => { calls.push(['maintenance', m]); }, stopChild: async () => { calls.push(['stop', current]); current = null; },
    startChild: async value => { current = value.name; calls.push(['start', current]); },
    probe: async p => { calls.push(['probe', current, p]); return current === 'new' ? p === '/new-health' : p === '/old-health'; },
    commit: async value => calls.push(['commit', value]), restore: async value => calls.push(['restore', value]), running: async () => calls.push(['running']), };
  return { service, previous, request, ops, calls, advance: n => { time += n; }, stop: () => { stopped = true; } };
}
test('successful app update retains expiry and changes only the supervised app', async () => {
  const t = scenario(); const result = await applyOriginUpdate(t.service, t.request, t.previous, t.ops);
  expect(result.phase).toBe('ready'); expect(result.expiresAt).toBe(t.service.expiresAt);
  expect(t.calls.find(c => c[0] === 'commit')[1]).toEqual({ updateId: 'fixture', active: { name: 'new', readyPath: '/new-health' }, previous: t.previous.active });
  expect(t.calls.filter(c => c[0] === 'start')).toEqual([['start', 'new']]);
});
test('failed candidate restores the old readiness path AND full earlier rollback record', async () => {
  const t = scenario(); t.ops.probe = async p => { t.calls.push(['probe', p]); return p === '/old-health'; };
  const result = await applyOriginUpdate(t.service, t.request, t.previous, t.ops);
  expect(result.phase).toBe('rolled-back'); expect(t.calls.filter(c => c[0] === 'start')).toEqual([['start', 'new'], ['start', 'old']]);
  expect(t.calls.find(c => c[0] === 'restore')[1]).toEqual(t.previous);
  expect(t.calls.some(c => c[0] === 'commit')).toBe(false);
});
test('stop and original expiry abort rollback instead of renewing or respawning', async () => {
  for (const reason of ['stop', 'expiry']) {
    const t = scenario(); t.ops.probe = async () => { reason === 'stop' ? t.stop() : t.advance(120000); return false; };
    const result = await applyOriginUpdate(t.service, t.request, t.previous, t.ops);
    expect(['aborted', 'rollback-failed']).toContain(result.phase); expect(t.calls.filter(c => c[0] === 'start')).toEqual([['start', 'new']]);
  }
});
test('maintenance permits the same tunnel only inside the fixed window, never past TTL or invalid ownership', () => {
  const now = Date.now(), startedAt = new Date(now).toISOString();
  const r = { status: 'maintaining', workerPid: 123, expiresAt: new Date(now + MAINTENANCE_MS).toISOString(), maintenance: { workerPid: 123, startedAt, until: new Date(now + MAINTENANCE_MS).toISOString() } };
  expect(originAllowsTunnel(r, now + 1)).toBe(true); expect(originAllowsTunnel(r, now + MAINTENANCE_MS)).toBe(false);
  expect(originAllowsTunnel({ ...r, maintenance: { ...r.maintenance, workerPid: 9 } }, now)).toBe(false);
  expect(originAllowsTunnel({ ...r, maintenance: { ...r.maintenance, until: new Date(now + MAINTENANCE_MS + 1).toISOString() } }, now)).toBe(false);
  expect(originAllowsTunnel({ ...r, status: 'stopping' }, now)).toBe(false);
});
test('failed rollback is reported, not treated as a successful update', async () => {
  const t = scenario(); t.ops.probe = async () => false;
  const result = await applyOriginUpdate(t.service, t.request, t.previous, t.ops);
  expect(result.phase).toBe('rollback-failed'); expect(t.calls.some(c => c[0] === 'running')).toBe(false);
});

test('stop arriving during commit or rollback restore never publishes a ready result', async () => {
  for (const stage of ['commit', 'restore']) {
    const t = scenario();
    if (stage === 'restore') t.ops.probe = async p => p === '/old-health';
    t.ops[stage] = async () => t.stop();
    const result = await applyOriginUpdate(t.service, t.request, t.previous, t.ops);
    expect(result.phase).toBe('aborted'); expect(t.calls.some(c => c[0] === 'running')).toBe(false);
  }
});
