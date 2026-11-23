// AgriTrade WhatsApp bot — free-tier build.
// Baileys (unofficial WhatsApp Web socket) + Supabase (data + session mirror).
// Reply-first design: the bot answers subscribers and sends one daily brief to
// opted-in numbers only. No cold messaging. Low volume to limit ban risk.

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const M = require('./messages');
const data = require('./data');
const authMirror = require('./supabase-auth');

const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth_info');
const PAIRING_PHONE = (process.env.PAIRING_PHONE || '').replace(/\D/g, '');
const ADMIN_PHONE = (process.env.ADMIN_PHONE || '').replace(/\D/g, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me';
const SELF_URL = (process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const PORT = parseInt(process.env.PORT || '10000', 10);

const MAX_BROADCAST = parseInt(process.env.MAX_BROADCAST || '150', 10);
const IGNORE_PHONES = (process.env.IGNORE_PHONES || '')
  .split(',')
  .map((p) => p.replace(/\D/g, ''))
  .filter(Boolean);
const MAX_QUESTIONS_PER_DAY = 20;

let sock = null;
let latestPairingCode = null;
let connectionState = 'init';
const sendQueue = [];
let sending = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

// Serialize all outgoing messages with a small human-like gap.
async function enqueueSend(jid, text) {
  return new Promise((resolve, reject) => {
    sendQueue.push({ jid, text, resolve, reject });
    pumpQueue();
  });
}

async function pumpQueue() {
  if (sending) return;
  sending = true;
  while (sendQueue.length) {
    const { jid, text, resolve, reject } = sendQueue.shift();
    try {
      if (sock) {
        await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        await sleep(rand(600, 1500));
        await sock.sendMessage(jid, { text });
        resolve();
      } else {
        reject(new Error('socket not connected'));
      }
    } catch (e) {
      reject(e);
    }
    await sleep(rand(1000, 2500));
  }
  sending = false;
}

function normalizePhone(jid) {
  return (jid || '').split('@')[0].replace(/\D/g, '');
}

async function startSocket() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    await authMirror.restoreAuthFromSupabase(AUTH_DIR);
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: ['AgriTrade Bot', 'Chrome', '1.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    authMirror.scheduleMirror(AUTH_DIR, 10000);
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      // QR fallback: log it so it can be scanned from the host's console if needed.
      console.log('QR received (use pairing code instead):', qr.slice(0, 40) + '...');
      connectionState = 'awaiting-pairing';
    }
    if (connection === 'open') {
      connectionState = 'connected';
      console.log('WhatsApp connected as', normalizePhone(sock.user?.id));
      await authMirror.mirrorAuthToSupabase(AUTH_DIR);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      connectionState = 'closed';
      console.log('connection closed, code:', code);
      if (code === DisconnectReason.loggedOut) {
        console.log('logged out — clearing auth, waiting for new pairing');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        authMirror.clearRemoteAuth();
        latestPairingCode = null;
        connectionState = 'logged-out';
        setTimeout(startSocket, 5000);
      } else {
        setTimeout(startSocket, rand(3000, 8000));
      }
    }
  });

  // Request a pairing code once, when unregistered.
  if (!state.creds.registered && PAIRING_PHONE) {
    setTimeout(async () => {
      try {
        latestPairingCode = await sock.requestPairingCode(PAIRING_PHONE);
        connectionState = 'awaiting-pairing';
        console.log('PAIRING CODE for', PAIRING_PHONE, '=', latestPairingCode);
      } catch (e) {
        console.error('pairing code request failed:', e.message);
      }
    }, 4000);
  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (e) {
        console.error('handleMessage error:', e.message);
      }
    }
  });
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || msg.key.fromMe) return;
  if (jid === 'status@broadcast') return;
  if (jid.endsWith('@g.us')) return; // no groups: ban-safety default

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    '';
  if (!text.trim()) return;

  const phone = normalizePhone(jid);
  const name = msg.pushName || '';
  const body = text.trim();
  const lower = body.toLowerCase();
  const isAdmin = ADMIN_PHONE && phone.endsWith(ADMIN_PHONE.slice(-10));

  // Hard-ignore list (never read or reply): Instinct's own number and anything
  // else the owner flags. This is the owner's personal WhatsApp, so silence is
  // the default for ordinary chats.
  if (IGNORE_PHONES.some((p) => phone.endsWith(p.slice(-10)))) return;

  // ---- Admin commands ----
  if (isAdmin) {
    if (body.startsWith('بث ') || body.startsWith('بث:') || body.startsWith('بث:')) {
      const payload = body.replace(/^بث\s*[:：]?\s*/, '');
      if (!payload) return;
      const subs = await data.listActiveSubscribers();
      let sent = 0;
      for (const s of subs.slice(0, MAX_BROADCAST)) {
        if (s.phone === phone) continue;
        await enqueueSend(`${s.phone}@s.whatsapp.net`, payload);
        sent++;
        await sleep(rand(3000, 7000)); // slow, human-paced broadcast
      }
      await enqueueSend(jid, M.BROADCAST_DONE(sent));
      return;
    }
    if (body === 'احصائيات' || body === 'عدد') {
      const n = await data.countActiveSubscribers();
      await enqueueSend(jid, `عدد المشتركين النشطين: ${n}`);
      return;
    }
    if (body === 'كود') {
      await enqueueSend(jid, latestPairingCode ? M.PAIRING_CODE_MSG(latestPairingCode) : 'مفيش كود حاليا، الحالة: ' + connectionState);
      return;
    }
  }

  // ---- Unsubscribe ----
  if (['إلغاء', 'الغاء', 'ايقاف', 'إيقاف', 'stop', 'unsubscribe'].some((k) => lower.includes(k))) {
    await data.upsertSubscriber(phone, name, false).catch(() => {});
    await enqueueSend(jid, M.UNSUBSCRIBED);
    return;
  }

  // ---- Subscribe ----
  if (['اشتراك', 'إشتراك', 'ابدا', 'أبدا', 'start'].some((k) => lower === k || lower.startsWith(k + ' '))) {
    const existing = await data.getSubscriber(phone).catch(() => null);
    await data.upsertSubscriber(phone, name, true).catch(() => {});
    await enqueueSend(jid, existing && existing.active ? M.ALREADY_SUBSCRIBED : M.WELCOME_SUBSCRIBED);
    return;
  }

  // ---- Subscriber gate: beyond subscribe/unsubscribe keywords and admin
  // commands, only whitelisted active subscribers get replies. Everyone else
  // (ordinary personal chats on the owner's own number) gets silence.
  if (!isAdmin) {
    const sub = await data.getSubscriber(phone).catch(() => null);
    if (!sub || !sub.active) return;
  }

  // ---- Menu options ----
  if (body === '1' || body === '١' || lower.includes('موجز')) {
    const brief = await data.getTodayBrief().catch(() => null);
    await enqueueSend(jid, brief ? `🌾 *موجز أجري تريد*\n\n${brief}` : M.BRIEF_UNAVAILABLE);
    return;
  }

  if (body === '2' || body === '٢' || lower.includes('سعر') || lower.includes('اسعار') || lower.includes('أسعار')) {
    const prices = await data.getPrices().catch(() => null);
    await enqueueSend(jid, prices || M.PRICES_UNAVAILABLE);
    return;
  }

  if (body === '3' || body === '٣') {
    await enqueueSend(jid, 'اتفضل اكتب سؤالك وهجاوبك على قد ما أقدر 👇');
    return;
  }

  // ---- Free question ----
  if (body.length > 3) {
    const todayCount = await data.countTodayQuestions(phone).catch(() => 0);
    if (todayCount >= MAX_QUESTIONS_PER_DAY) {
      await enqueueSend(jid, M.ASK_LIMIT_REACHED);
      return;
    }
    const brief = await data.getTodayBrief().catch(() => null);
    const answer = await data.askGemini(body, brief).catch(() => null);
    if (answer) {
      await data.recordQuestion(phone, body).catch(() => {});
      await enqueueSend(jid, answer.slice(0, 1500));
    } else {
      await data.recordQuestion(phone, body).catch(() => {});
      await enqueueSend(jid, M.ASK_RECEIVED);
    }
    return;
  }

  if (isAdmin) await enqueueSend(jid, M.UNKNOWN);
}

// ---- Tiny HTTP server: health, status, pairing code ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (url.pathname === '/pairing-code') {
    if (url.searchParams.get('key') !== ADMIN_SECRET) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    // Mint a fresh code on demand: pairing codes expire within minutes,
    // so a stored code from boot time is usually stale by the time the
    // user is ready to type it.
    if (sock && !sock.authState.creds.registered && connectionState !== 'logged-out') {
      try {
        latestPairingCode = await sock.requestPairingCode(PAIRING_PHONE);
        connectionState = 'awaiting-pairing';
      } catch (e) {
        console.error('on-demand pairing code failed:', e.message);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: connectionState, pairingCode: latestPairingCode }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`AgriTrade WhatsApp bot — state: ${connectionState}`);
});

server.listen(PORT, () => console.log('http server on', PORT));

// Keep the free web service awake: ping our own health route every 10 minutes
// so the host sees inbound traffic and does not spin the service down.
if (SELF_URL && !DRY_RUN) {
  setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000);
  // Mirror the auth session periodically even when quiet.
  setInterval(() => authMirror.mirrorAuthToSupabase(AUTH_DIR), 5 * 60 * 1000);
}

if (DRY_RUN) {
  (async () => {
    console.log('DRY RUN — config check only, not connecting to WhatsApp');
    console.log('pairing phone set:', Boolean(PAIRING_PHONE));
    console.log('admin phone set:', Boolean(ADMIN_PHONE));
    console.log('supabase configured:', data.configured());
    const { useMultiFileAuthState: u, fetchLatestBaileysVersion: f } = require('@whiskeysockets/baileys');
    const { version } = await f();
    console.log('baileys WA version:', version.join('.'));
    process.exit(0);
  })();
} else {
  startSocket().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
}
