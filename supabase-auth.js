// Mirrors the Baileys auth folder to Supabase so the WhatsApp session survives
// restarts on hosts with no persistent disk (e.g. Render free tier).

const fs = require('fs');
const path = require('path');

const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let backupStatus = { lastSuccessAt: null, fileCount: 0, lastError: null };
const hasSession = (c) => Boolean(c && c.me && c.me.id && c.account);
function getBackupStatus() { return { enabled: enabled(), ...backupStatus }; }

function enabled() {
  return Boolean(SUPA_URL && SUPA_KEY);
}

async function upsertFile(filename, contentB64) {
  const res = await fetch(`${SUPA_URL}/rest/v1/wa_auth_files`, {
    method: 'POST',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ filename, content: contentB64, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`auth mirror upsert failed: ${res.status}`);
}

async function listRemoteFiles() {
  const rows = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const res = await fetch(`${SUPA_URL}/rest/v1/wa_auth_files?select=filename,content&order=filename.asc&limit=500&offset=${offset}`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`auth mirror read failed: ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw new Error('auth mirror exceeds safe restore size');
}

let mirrorInFlight = null;
async function mirrorAuthToSupabase(dir) {
  if (!enabled()) return;
  if (mirrorInFlight) return mirrorInFlight;
  mirrorInFlight = (async () => {
    try {
      const credsPath = path.join(dir, 'creds.json');
      if (!fs.existsSync(credsPath) || !hasSession(JSON.parse(fs.readFileSync(credsPath, 'utf8')))) return;
      const rows = [];
      for (const filename of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        try {
          const content = fs.readFileSync(path.join(dir, filename)).toString('base64');
          rows.push({ filename, content, updated_at: new Date().toISOString() });
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      const res = await fetch(`${SUPA_URL}/rest/v1/wa_auth_files`, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`auth mirror bulk upsert failed: ${res.status}`);
      backupStatus = { lastSuccessAt: new Date().toISOString(), fileCount: rows.length, lastError: null };
      console.log('auth mirror saved:', rows.length, 'files');
    } catch (e) {
      backupStatus.lastError = e.message;
      console.error('auth mirror save error:', e.message);
    }
  })();
  try { await mirrorInFlight; } finally { mirrorInFlight = null; }
}

async function clearRemoteAuth() {
  if (mirrorTimer) clearTimeout(mirrorTimer);
  if (!enabled()) return;
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/wa_auth_files?filename=neq.__none__`, {
      method: 'DELETE',
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!res.ok) throw new Error(`auth mirror clear failed: ${res.status}`);
  } catch (e) {
    console.error('auth mirror clear error:', e.message);
  }
}

async function restoreAuthFromSupabase(dir) {
  if (!enabled()) return false;
  try {
    const rows = await listRemoteFiles();
    if (!rows || !rows.length) return false;
    const credsRow = rows.find(r => r.filename === 'creds.json');
    if (!credsRow || !hasSession(JSON.parse(Buffer.from(credsRow.content, 'base64').toString()))) return false;
    fs.mkdirSync(dir, { recursive: true });
    for (const row of rows) {
      fs.writeFileSync(path.join(dir, row.filename), Buffer.from(row.content, 'base64'));
    }
    console.log(`auth restored from Supabase (${rows.length} files)`);
    return true;
  } catch (e) {
    console.error('auth restore error:', e.message);
    return false;
  }
}

let mirrorTimer = null;
function scheduleMirror(dir, delayMs = 10000) {
  if (mirrorTimer) clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => mirrorAuthToSupabase(dir), delayMs);
}

module.exports = { mirrorAuthToSupabase, restoreAuthFromSupabase, scheduleMirror, clearRemoteAuth, getBackupStatus };
