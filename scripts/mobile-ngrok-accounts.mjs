#!/usr/bin/env bun
import { readInventory, readChecks, recordCheck, migrateInventory, inventoryFile } from './lib/ngrok-accounts.mjs';
import { createManager } from './mobile-service.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
async function main() {
  const [command, id, ...args] = process.argv.slice(2);
  if (command === 'location') {
    console.log(inventoryFile);
  } else if (command === 'migrate') {
    if (id !== '--from' || args.length !== 1) throw new Error('migrate --from ABS_OLD_ENV');
    console.log(JSON.stringify(await migrateInventory(args[0]), null, 2));
  } else if (command === 'list') {
    const accounts = await readInventory(), checks = await readChecks();
    const services = await createManager().list(), agents = [];
    for (const s of services.filter(s => s.status !== 'closed')) {
      if (!s.argv?.some(a => a.endsWith('/mobile-ngrok.mjs'))) continue;
      let receipt; try { receipt = JSON.parse(await fs.readFile(path.join(s.directory, 'ngrok.json'), 'utf8')); } catch {}
      agents.push({ serviceId: s.id, originServiceId: s.argv[2], status: s.status, accountId: receipt?.account?.accountId || 'legacy-unverified', baseUrl: receipt?.baseUrl || null, expiresAt: s.expiresAt });
    }
    console.log(JSON.stringify({ accounts: accounts.map(a => ({ ...a, check: checks[a.id] ? { quota: checks[a.id].quota, checkedAt: checks[a.id].checkedAt, note: 'Recorded observation, not a live quota query' } : { quota: 'unknown' } })), managedAgents: agents, note: 'Also inspect live listeners and the selected dashboard agent sessions; inventory does not establish ownership of unmanaged agents.' }, null, 2));
  } else if (command === 'check') {
    if (args.length !== 6 || args[0] !== '--identity' || args[2] !== '--quota' || args[4] !== '--source') throw new Error('check ID --identity EMAIL --quota available|exhausted|unknown --source dashboard');
    const account = (await readInventory()).find(a => a.id === id);
    if (!account) throw new Error('Unknown account ID');
    const result = await recordCheck(account, { identity: args[1], quota: args[3], source: args[5] });
    console.log(JSON.stringify({ accountId: id, quota: result.quota, checkedAt: result.checkedAt }));
  } else throw new Error('Usage: mobile-ngrok-accounts.mjs location | migrate --from ABS_OLD_ENV | list | check ID --identity EMAIL --quota available|exhausted|unknown --source dashboard');
}
if (import.meta.main) main().catch(e => { console.error(e.message); process.exitCode = 1; });
