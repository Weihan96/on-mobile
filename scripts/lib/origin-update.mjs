/** Bounded app replacement; never changes the origin identity, port, TTL or tunnel. */
export const MAINTENANCE_MS = 60000;
export function originAllowsTunnel(service, now = Date.now()) {
  if (!(now < Date.parse(service.expiresAt))) return false;
  if (service.status === 'running') return true;
  const m = service.maintenance, start = Date.parse(m?.startedAt), end = Date.parse(m?.until);
  return service.status === 'maintaining' && !!service.workerPid && m?.workerPid === service.workerPid &&
    now >= start && now < end && end <= start + MAINTENANCE_MS && end <= Date.parse(service.expiresAt);
}
export async function applyOriginUpdate(service, request, previous, ops) {
  const start = ops.now(), until = Math.min(start + MAINTENANCE_MS, Date.parse(service.expiresAt));
  if (until - start < 15000 || await ops.stopping()) throw new Error('Not enough original lifetime for a bounded update');
  const maintenance = { id: request.id, workerPid: service.workerPid, startedAt: new Date(start).toISOString(), until: new Date(until).toISOString() };
  const active = async () => { if (ops.now() >= until || await ops.stopping()) throw new Error('Maintenance deadline, expiry or stop requested'); };
  const ready = async (readyPath, deadline) => {
    while (ops.now() < deadline) {
      await active();
      if (await ops.probe(readyPath)) { await active(); return; }
      await ops.sleep(200);
    }
    throw new Error('Application readiness failed');
  };
  await ops.begin(maintenance);
  let failure;
  try {
    await active(); await ops.stopChild(); await active();
    await ops.startChild(request.candidate);
    await ready(request.readyPath, Math.min(start + 25000, until - 15000));
    await active(); await ops.commit({ updateId: request.id, active: { ...request.candidate, readyPath: request.readyPath }, previous: previous.active });
    await active(); await ops.running(); await active();
    return { id: request.id, phase: 'ready', expiresAt: service.expiresAt };
  } catch { failure = 'Candidate did not become ready; attempted the previous release'; }
  try {
    await ops.stopChild(); await active();
    await ops.startChild(previous.active); await ready(previous.active.readyPath || "/", until);
    await ops.restore(previous); await active(); await ops.running(); await active();
    return { id: request.id, phase: 'rolled-back', expiresAt: service.expiresAt, error: failure };
  } catch {
    await ops.stopChild().catch(() => {});
    return { id: request.id, phase: await ops.stopping() ? 'aborted' : 'rollback-failed', expiresAt: service.expiresAt,
      error: 'Update failed; retained releases and receipts. No successful deployment or rollback claimed.' };
  }
}
