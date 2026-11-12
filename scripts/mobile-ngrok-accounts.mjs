#!/usr/bin/env bun
import { readInventory, readChecks, recordCheck, migrateInventory, migrateChecks, inventoryFile, checksFile, policyFile, quotaStatus, rotationCandidates, updatePrivateJSON, withRotationLock, authorizeRotationService } from './lib/ngrok-accounts.mjs';
import { createManager } from './mobile-service.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
function flags(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] == null || values[args[i].slice(2)] != null) throw new Error('Expected unique --flag value pairs');
    values[args[i].slice(2)] = args[i + 1];
  }
  return values;
}
async function main() {
  const [command, id, ...args] = process.argv.slice(2);
  if (command === 'location') {
    console.log(inventoryFile);
  } else if (command === 'migrate' || command === 'migrate-checks') {
    if (id !== '--from' || args.length !== 1) throw new Error(`${command} --from ABS_OLD_FILE`);
    console.log(JSON.stringify(await (command === 'migrate' ? migrateInventory : migrateChecks)(args[0]), null, 2));
  } else if (command === 'rotation') {
    if (!['on','off','status'].includes(id)) throw new Error('rotation on --accounts ID,ID | off | status');
    if (id === 'status') { console.log(JSON.stringify(await readChecks(policyFile), null, 2)); return; }
    const options = flags(args), accounts = id === 'on' ? options.accounts?.split(',') : undefined;
    if (id === 'on') {
      const known = new Set((await readInventory()).map(a => a.id));
      if (!accounts?.length || new Set(accounts).size !== accounts.length || accounts.some(a => !known.has(a))) throw new Error('Authorize distinct registered account IDs, in priority order');
    }
    await withRotationLock(() => updatePrivateJSON(policyFile, current => ({ ...current, enabled: id === 'on', ...(accounts ? { accounts } : {}), updatedAt: new Date().toISOString() })));
    console.log(JSON.stringify({ enabled: id === 'on', accounts }));
  } else if (command === 'authorize') {
    if (args.length) throw new Error('authorize SERVICE_ID');
    const service = await createManager().readService(id);
    await withRotationLock(() => authorizeRotationService(service, process.env.CODEX_THREAD_ID));
    console.log(JSON.stringify({ serviceId: id, expiresAt: service.expiresAt, authorized: true }));
  } else if (command === 'candidates') {
    console.log(JSON.stringify(await rotationCandidates(), null, 2));
  } else if (command === 'list') {
    const accounts = await readInventory(), checks = await readChecks();
    const services = await createManager().list(), agents = [];
    for (const s of services.filter(s => s.status !== 'closed')) {
      if (!s.argv?.some(a => a.endsWith('/mobile-ngrok.mjs'))) continue;
      let receipt; try { receipt = JSON.parse(await fs.readFile(path.join(s.directory, 'ngrok.json'), 'utf8')); } catch {}
      agents.push({ serviceId: s.id, originServiceId: s.argv[2], status: s.status, accountId: receipt?.account?.accountId || 'legacy-unverified', baseUrl: receipt?.baseUrl || null, expiresAt: s.expiresAt });
    }
    console.log(JSON.stringify({ accounts: accounts.map(a => ({ ...a, observation: checks[a.id] || null, current: quotaStatus(checks[a.id]) })), managedAgents: agents, note: 'Recorded evidence, not a live quota query. Unknown/stale/reset-due states require dashboard verification.' }, null, 2));
  } else if (command === 'check') {
    const options = flags(args);
    const mapping = { identity: 'identity', quota: 'quota', source: 'source', 'checked-at': 'checkedAt', 'used-bytes': 'usedBytes', 'limit-bytes': 'limitBytes', 'cycle-start': 'cycleStart', 'cycle-end': 'cycleEnd', 'provider-reset-at': 'providerResetAt', 'estimated-reset-at': 'estimatedResetAt', 'error-code': 'errorCode' };
    const input = {};
    for (const [key, value] of Object.entries(options)) {
      if (!mapping[key]) throw new Error(`Unknown check flag: ${key}`);
      input[mapping[key]] = ['used-bytes', 'limit-bytes'].includes(key) ? Number(value) : value;
    }
    const account = (await readInventory()).find(a => a.id === id);
    if (!account) throw new Error('Unknown account ID');
    const result = await recordCheck(account, input);
    console.log(JSON.stringify({ accountId: id, observation: result, current: quotaStatus(result) }, null, 2));
  } else throw new Error('Usage: mobile-ngrok-accounts.mjs location | migrate --from FILE | migrate-checks --from FILE | list | check ID --identity EMAIL --quota available|exhausted|unknown --source dashboard|provider-error|user-report [--used-bytes N --limit-bytes N --cycle-start ISO --cycle-end ISO --provider-reset-at ISO --estimated-reset-at ISO --checked-at ISO --error-code ERR_NGROK_725] | rotation on --accounts ID,ID | rotation off|status | authorize SERVICE_ID | candidates');
}
if (import.meta.main) main().catch(e => { console.error(e.message); process.exitCode = 1; });
