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
  const res = await fetch(`${SUPA_URL}/rest/v1/wa_auth_files?select=filename,content`, {
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
  });
  if (!res.ok) throw new Error(`auth mirror read failed: ${res.status}`);
  return res.json();
}

async function mirrorAuthToSupabase(dir) {
  if (!enabled()) return;
  try {
    const credsPath = path.join(dir, 'creds.json');
    if (!fs.existsSync(credsPath) || !hasSession(JSON.parse(fs.readFileSync(credsPath, 'utf8')))) return;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const buf = fs.readFileSync(path.join(dir, f));
      await upsertFile(f, buf.toString('base64'));
    }
    backupStatus = { lastSuccessAt: new Date().toISOString(), fileCount: files.length, lastError: null };
    console.log('auth mirror saved:', files.length, 'files');
  } catch (e) {
    backupStatus.lastError = e.message;
    console.error('auth mirror save error:', e.message);
  }
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
