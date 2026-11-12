/** Bounded rotation; resource ownership is verified by the caller under both locks. */
export function classifyNgrokError(code) {
  if (code === 'ERR_NGROK_725') return 'exhausted';
  if (/^ERR_NGROK_\d+$/.test(code || '')) return 'provider-blocked';
  return 'unknown';
}
export async function probeNgrok(url, timeoutMs = 5000, request = fetch) {
  let response;
  const inspect = async method => request(url, { method, redirect: 'manual', headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(timeoutMs) });
  try {
    response = await inspect('HEAD');
    let code = response.headers.get('ngrok-error-code');
    if (code && /^\d+$/.test(code)) code = `ERR_NGROK_${code}`;
    // ngrok reserves this response header; upstreams cannot set it. Never
    // classify arbitrary application text containing an error-code example.
    if (!code && [405, 501].includes(response.status)) {
      await response.body?.cancel();
      response = await inspect('GET');
      code = response.headers.get('ngrok-error-code');
      if (code && /^\d+$/.test(code)) code = `ERR_NGROK_${code}`;
    }
    const errorCode = /^ERR_NGROK_\d+$/.test(code || '') ? code : null;
    return { ok: !errorCode && response.status >= 200 && response.status < 400, status: response.status, errorCode, classification: classifyNgrokError(errorCode), checkedAt: new Date().toISOString() };
  } catch { return { ok: false, status: 0, errorCode: null, classification: 'unknown', checkedAt: new Date().toISOString() }; }
  finally { await response?.body?.cancel().catch(() => {}); }
}
export async function rotateNgrok(service, options, ops) {
  const old = await ops.route();
  if (old && !old.removed) {
    if (old.kind !== 'ngrok' || !old.agentId || !old.accountId || old.accountId === 'legacy-unverified') throw new Error('Auto rotation requires a verified account-bound route');
    await ops.verify(old);
    const probe = await ops.probe(old);
    await ops.observed(old.accountId, probe);
    if (probe.ok) return ops.reuse(old);
    if (probe.classification !== 'exhausted') throw new Error('Non-quota failure: retained existing route; automatic rotation stopped');
  }
  const { candidates, skipped } = await ops.candidates(old && !old.removed ? [old.accountId] : []);
  if (!candidates.length) throw new Error('No verified available accounts; retained existing route. Dashboard recheck required');
  const audit = { originServiceId: service.id, oldRoute: old || null, expiresAt: service.expiresAt, startedAt: new Date().toISOString(), attempts: [], skipped, phase: 'prepared' };
  await ops.audit(audit);
  let current = old && !old.removed ? old : null;
  try {
    for (const binding of candidates) {
      await ops.check(binding.accountId); // Recheck after waiting/previous attempts.
      await ops.active();
      if (current) { await ops.verify(current); await ops.cleanup(); current = null; }
      const attempt = { accountId: binding.accountId, phase: 'starting', startedAt: new Date().toISOString() };
      audit.attempts.push(attempt); await ops.audit(audit);
      const result = await ops.create(binding.accountId);
      current = result.route;
      if (result.agent.expiresAt !== service.expiresAt) throw new Error('Replacement must retain the original deadline');
      const probe = await ops.probe(current);
      await ops.observed(binding.accountId, probe);
      Object.assign(attempt, { agentId: result.agent.id, url: current.baseUrl, probe, phase: probe.ok ? 'ready' : 'failed' });
      await ops.audit(audit);
      if (probe.ok) {
        Object.assign(audit, { phase: 'ready', newRoute: current, oldUrl: old?.baseUrl || null, newUrl: current.baseUrl, urlChanged: !!old?.baseUrl && old.baseUrl !== current.baseUrl, completedAt: new Date().toISOString() });
        await ops.audit(audit);
        return { ...result, rotation: audit };
      }
      if (probe.classification !== 'exhausted') throw new Error('Non-quota provider/probe failure; automatic rotation stopped');
    }
    throw new Error('Authorized candidates exhausted; no further automatic attempts');
  } catch (error) {
    Object.assign(audit, { phase: 'failed', recovery: 'Original origin and deadline retained. Inspect saved routes and agent receipts before explicit recovery; no automatic rollback.', restored: false, currentRoute: await ops.route(), failedAt: new Date().toISOString() });
    await ops.audit(audit);
    throw error;
  }
}
