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
    'reports?select=subject,body_text,received_at&app_visible=eq.true&sender=in.(AgriTrade%20Research,Agri%20Trade%20Pro%20Research)&order=received_at.desc&limit=3'
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

// No paid model or external AI disclosure: extract only matching published text.
const UNKNOWN_ANSWER = 'مش لاقي إجابة موثقة على سؤالك في التقارير والأخبار المنشورة عندنا. جرّب تحدد السلعة أو البلد أو التاريخ. مش هخمن رقم أو معلومة.';
function normalizeSearch(text) {
  return String(text || '').toLowerCase().normalize('NFKC')
    .replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ');
}
const ALIASES = [
  ['قمح','wheat'], ['ذره','ذرة','corn','maize'], ['صويا','soy','soybean','soybeans'],
  ['مصر','egypt','egyptian'], ['روسيا','روسي','russia','russian'],
  ['اوكرانيا','اوكراني','ukraine','ukrainian'], ['برازيل','brazil','brazilian'],
  ['ارجنتين','argentina','argentine'], ['زيت','oil'], ['شحن','freight'],
  ['اسعار','سعر','price','prices'], ['تصدير','صادرات','export','exports'],
  ['استيراد','واردات','import','imports'], ['انتاج','production'], ['مخزون','stocks','inventory'],
].map(g => g.map(normalizeSearch));
function queryGroups(question) {
  const stop = new Set(['ايه','ما','هي','هو','عن','في','من','الي','علي','هل','و','النهارده','اليوم','اخر','اخبار','the','what','is','of','and','in','latest']);
  const tokens = normalizeSearch(question).split(' ').filter(t => t.length > 1 && !stop.has(t));
  return tokens.map(t => ALIASES.find(g => g.includes(t) || g.includes(t.replace(/^ال/, ''))) || [t]);
}
function overlap(text, groups) {
  const words = new Set(normalizeSearch(text).split(' '));
  return groups.reduce((n,g) => n + (g.some(w => words.has(w) || words.has('ال'+w)) ? 1 : 0), 0);
}
async function answerQuestion(question) {
  const groups = queryGroups(question);
  const priceQuestion = /(?:سعر|اسعار|بكام|price)/.test(normalizeSearch(question));
  if (priceQuestion) {
    const priceGroups = groups.filter(g => !g.some(t => ['سعر','اسعار','price','prices','بكام'].includes(t)));
    if (!priceGroups.length) return 'حدد السلعة والبلد عشان أعرض سعر منشور بتاريخ واضح.';
    const rows = await sb('pp_prices?select=commodity,origin,destination,price_usd_t,price_local,currency,incoterm,basis_type,published_date&order=published_date.desc&limit=150').catch(()=>[]);
    const found = (rows||[]).filter(r => r.published_date && r.basis_type && r.basis_type.toUpperCase()!=='OTHER' && ['CIF','CFR','FOB','EXW','FCA','CPT','DAP','DDP'].includes((r.incoterm||'').toUpperCase()) && (r.price_usd_t||r.price_local) && overlap([r.commodity,r.origin,r.destination].join(' '),priceGroups)===priceGroups.length).slice(0,3);
    if(!found.length) return UNKNOWN_ANSWER;
    return 'أسعار منشورة في قاعدة أسعار أجري تريد، مش عرض بيع حالي:\n\n'+found.map(r=>[r.commodity,[r.origin,r.destination].filter(Boolean).join(' ← '),(r.price_usd_t ? '$'+r.price_usd_t+'/طن' : r.price_local+' '+r.currency)+' '+r.incoterm,'تاريخ السعر: '+r.published_date+(r.published_date<daysAgoISO(3)?' ⚠️ سعر قديم':'')].join('\n')).join('\n\n');
  }
  if (!groups.length) return UNKNOWN_ANSWER;
  const loads = await Promise.allSettled([
    sb('reports?select=subject,body_text,received_at&app_visible=eq.true&sender=in.(AgriTrade%20Research,Agri%20Trade%20Pro%20Research)&order=received_at.desc&limit=80'),
    sb('market_news?select=title,title_ar,summary,summary_ar,canonical_url,published_at&is_public=eq.true&verification_status=eq.verified&order=published_at.desc&limit=100'),
    sb('agritrade_daily_reports?select=title,content_markdown,report_date&status=in.(published,sent)&order=report_date.desc&limit=30'),
  ]);
  const rows = loads.map(r => r.status === 'fulfilled' ? r.value || [] : []);
  if (loads.every(r => r.status === 'rejected')) return 'المصادر المنشورة مش متاحة دلوقتي. جرب تاني بعد شوية، مش هخمن الإجابة.';
  const docs = [
    ...rows[0].map(r=>({title:r.subject,text:r.body_text,date:r.received_at})),
    ...rows[1].map(r=>({title:r.title_ar||r.title,text:r.summary_ar||r.summary,date:r.published_at,url:r.canonical_url})),
    ...rows[2].map(r=>({title:r.title,text:r.content_markdown,date:r.report_date})),
  ];
  const candidates = [];
  for (const d of docs) {
    const sentences = String(d.text||'').replace(/<[^>]*>/g,' ').split(/\n+|(?<=[.!?؟])\s+/).map(t=>t.trim()).filter(t=>t.length>25 && t.length<1800);
    for (const text of sentences) {
      const score=overlap(text,groups);
      if (score === groups.length) candidates.push({...d,text,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score || String(b.date||'').localeCompare(String(a.date||'')));
  const picked=[]; const seen=new Set();
  for(const c of candidates) { if(seen.has(c.title)) continue; seen.add(c.title); picked.push(c); if(picked.length===2) break; }
  if (!picked.length) return UNKNOWN_ANSWER;
  return 'ده النص المرتبط بسؤالك من منشوراتنا، نقل مباشر مش تحليل أو توقع جديد:\n\n'+picked.map(d=>`المصدر: ${d.title}\nتاريخ النشر: ${d.date ? String(d.date).slice(0,10) : 'غير متاح'}\n«${d.text.slice(0,700)}${d.text.length>700?'…':''}»${d.url?'\n'+d.url:''}`).join('\n\n')+'\n\nالمعلومات بتاريخ المصدر، مش بالضرورة أسعار أو أحداث النهارده.';
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
  answerQuestion,
  queryGroups,
  overlap,
};
