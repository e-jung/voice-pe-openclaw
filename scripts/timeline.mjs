import { readFile } from 'node:fs/promises';

// Read an SSH-fetched JSONL capture. No credentials or network operations.
if (!process.argv[2]) throw new Error('Usage: node scripts/timeline.mjs events.jsonl [older.jsonl ...]');
const rows = [];
for (const file of process.argv.slice(2)) {
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row.schema === 1) rows.push(row); } catch { /* incomplete final line */ }
  }
}
rows.sort((a, b) => a.ts.localeCompare(b.ts) || a.sequence - b.sequence);
const groups = new Map();
for (const r of rows) {
  const key = `${r.bootId}:${r.connectionId ?? 'process'}:${r.call ?? 0}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}
for (const group of groups.values()) {
  const first = group[0];
  console.log(`\n${first.ts} revision=${first.revision} connection=${first.connectionId ?? 'process'} call=${first.call ?? 0}`);
  for (const r of group) {
    const detail = Object.fromEntries(Object.entries(r).filter(([k]) => !['schema','ts','ms','bootId','sequence','revision','event','connectionId','call','hashes'].includes(k)));
    console.log(`+${r.ms - first.ms}ms ${r.event} ${JSON.stringify(detail)}`);
  }
  const last = group.at(-1), snapshot = group.findLast(r => r.event === 'snapshot');
  if (snapshot?.speaking === 1 && !group.some(r => r.ms > snapshot.ms && (r.phase === 'idle' || r.event === 'disconnect')))
    console.log(`UNRESOLVED OUTPUT at end of capture; exact-zero=${snapshot.exactZero}/${snapshot.frames}, near-zero=${snapshot.nearZero}, lastPeak=${snapshot.lastPeak}`);
  if (group.some(r => r.control === 'flush')) console.log('Follow-up expired/flushed; inspect provider user-final timing above.');
  if (last.dropped) console.log('Logging backpressure: capture is incomplete.');
}
