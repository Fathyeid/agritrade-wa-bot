// Data layer: reads market data from the AgriTrade Supabase project over REST.
// Uses the service role key (server-side only, never shipped to a client).

const SUPA_URL = process.env.SUPABASE_URL || '';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function configured() {
  return Boolean(SUPA_URL && SUPA_KEY);
}

async function sb(path, opts = {}) {
  if (!configured()) return null;
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`Supabase ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

function cairoDate(d) {
  return new Date(d).toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Today's brief: newest visible reports from the reports table (known schema).
async function getTodayBrief() {
  const rows = await sb(
    'reports?select=subject,body_text,received_at&app_visible=eq.true&order=received_at.desc&limit=3'
  );
  if (!rows || !rows.length) return null;
  const parts = rows.map((r) => {
    const body = (r.body_text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return `📰 *${r.subject}*\n🕐 ${cairoDate(r.received_at)}\n${body}${(r.body_text || '').length > 400 ? '...' : ''}`;
  });
  return parts.join('\n\n──────────\n\n');
}

// Prices: live physical prices from public.pp_prices.
// Rules (from the data owner): published_date is the price date (not last_seen) —
// always show it; show incoterm + destination; skip OTHER/non-physical rows;
// never assume every row is CIF Egypt; label stale prices as old.
function daysAgoISO(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function getPrices() {
  const cols =
    'commodity,grade,origin,destination,price_usd_t,price_local,currency,incoterm,basis_type,published_date';
  const rows = await sb(
    `pp_prices?select=${cols}&order=published_date.desc,last_seen.desc&limit=80`
  );
  if (!rows || !rows.length) return null;

  const physical = rows.filter(
    (r) => (r.basis_type || '').toUpperCase() !== 'OTHER' && (r.price_usd_t || r.price_local)
  );
  if (!physical.length) return null;

  // Latest quote per commodity/origin/destination combination.
  const seen = new Set();
  const picked = [];
  for (const r of physical) {
    const k = [r.commodity, r.origin, r.destination].join('|');
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(r);
    if (picked.length >= 8) break;
  }

  const staleBefore = daysAgoISO(3);
  const lines = picked.map((r) => {
    const price = r.price_usd_t
      ? `$${r.price_usd_t}/طن`
      : `${r.price_local} ${r.currency || ''}`.trim();
    const route = [r.origin, r.destination].filter(Boolean).join(' ← ');
    const date = r.published_date || 'تاريخ غير معروف';
    const stale = r.published_date && r.published_date < staleBefore ? ' ⚠️ سعر قديم' : '';
    return `▪️ *${r.commodity || 'سلعة'}*${r.grade ? ' ' + r.grade : ''}${route ? '\n' + route : ''}\n${price}${r.incoterm ? ' ' + r.incoterm : ''} | بتاريخ ${date}${stale}`;
  });

  return `💹 *أحدث الأسعار المنشورة:*\n\n${lines.join('\n\n')}`;
}

async function upsertSubscriber(phone, name, active) {
  return sb('wa_subscribers', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates',
    body: {
      phone,
      name: name || null,
      active,
      last_seen_at: new Date().toISOString(),
      ...(active ? { opted_in_at: new Date().toISOString() } : {}),
    },
  });
}

async function getSubscriber(phone) {
  const rows = await sb(`wa_subscribers?select=*&phone=eq.${encodeURIComponent(phone)}&limit=1`);
  return rows && rows[0] ? rows[0] : null;
}

async function listActiveSubscribers() {
  const rows = await sb('wa_subscribers?select=phone,name&active=eq.true');
  return rows || [];
}

async function countActiveSubscribers() {
  const rows = await sb('wa_subscribers?select=phone&active=eq.true');
  return rows ? rows.length : 0;
}

async function recordQuestion(phone, question) {
  return sb('wa_questions', {
    method: 'POST',
    body: { phone, question },
  });
}

async function countTodayQuestions(phone) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await sb(
    `wa_questions?select=id&phone=eq.${encodeURIComponent(phone)}&created_at=gte.${start.toISOString()}`
  );
  return rows ? rows.length : 0;
}

// Optional: answer with Gemini free tier.
async function askGemini(question, context) {
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const body = {
    system_instruction: {
      parts: [
        {
          text:
            'انت مساعد خبير في سوق الحبوب المصري (قمح، ذرة، صويا، أسعار CIF وCBOT). ' +
            'رد بالعامية المصرية، باختصار ووضوح، ولو مش متأكد من رقم قول إن ده تقدير. ' +
            (context ? `آخر موجز عندك للسياق:\n${context.slice(0, 1500)}` : ''),
        },
      ],
    },
    contents: [{ role: 'user', parts: [{ text: question }] }],
    generationConfig: { maxOutputTokens: 500 },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  return text.trim() || null;
}

module.exports = {
  configured,
  getTodayBrief,
  getPrices,
  upsertSubscriber,
  getSubscriber,
  listActiveSubscribers,
  countActiveSubscribers,
  recordQuestion,
  countTodayQuestions,
  askGemini,
};
