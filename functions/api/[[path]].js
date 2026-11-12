// Dira API — Cloudflare Pages Function, backed by D1 (binding: DB)

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS apartments (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, token TEXT UNIQUE NOT NULL, position INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chores (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT, weight INTEGER NOT NULL DEFAULT 1, freq_days INTEGER NOT NULL DEFAULT 7, start_day INTEGER NOT NULL, offset_ INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chore_overrides (chore_id TEXT NOT NULL, period INTEGER NOT NULL, member_id TEXT NOT NULL, PRIMARY KEY (chore_id, period))`,
  `CREATE TABLE IF NOT EXISTS chore_done (chore_id TEXT NOT NULL, period INTEGER NOT NULL, member_id TEXT NOT NULL, done_at INTEGER NOT NULL, image_id TEXT, PRIMARY KEY (chore_id, period))`,
  `CREATE TABLE IF NOT EXISTS swaps (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, chore_id TEXT NOT NULL, period INTEGER NOT NULL, from_member TEXT NOT NULL, to_member TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS shopping (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, name TEXT NOT NULL, qty TEXT, note TEXT, kind TEXT NOT NULL DEFAULT 'shared', urgent INTEGER NOT NULL DEFAULT 0, added_by TEXT NOT NULL, added_at INTEGER NOT NULL, bought_by TEXT, bought_at INTEGER, cleared INTEGER NOT NULL DEFAULT 0, inventory_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, name TEXT NOT NULL, icon TEXT, status TEXT NOT NULL DEFAULT 'ok', updated_by TEXT, updated_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'note', pinned INTEGER NOT NULL DEFAULT 0, author TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open', landlord INTEGER NOT NULL DEFAULT 0, assignee TEXT, image_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS info (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, label TEXT NOT NULL, value TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS polls (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, question TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS poll_options (id TEXT PRIMARY KEY, poll_id TEXT NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS poll_votes (poll_id TEXT NOT NULL, member_id TEXT NOT NULL, option_id TEXT NOT NULL, PRIMARY KEY (poll_id, member_id))`,
  `CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS duty (apartment_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, started_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS duty_log (id TEXT PRIMARY KEY, apartment_id TEXT NOT NULL, member_id TEXT NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL, done_at INTEGER NOT NULL, done_by TEXT NOT NULL, image_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, member_id TEXT NOT NULL, apartment_id TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS notif_log (member_id TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (member_id, kind, day))`,
  `CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_duty_log_apt ON duty_log(apartment_id, done_at)`,
  `CREATE INDEX IF NOT EXISTS idx_members_apt ON members(apartment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shopping_apt ON shopping(apartment_id, cleared)`,
  `CREATE INDEX IF NOT EXISTS idx_notices_apt ON notices(apartment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_issues_apt ON issues(apartment_id)`,
];

const COLORS = ['#e76f51', '#2a9d8f', '#8e7dbe', '#e9a23b', '#457b9d', '#d1495b', '#66a182', '#c77dff'];

const DEFAULT_CHORES = [
  ['שירותים', '🚽', 3, 7],
  ['מקלחת', '🚿', 3, 7],
  ['מטבח (משטחים, כיריים, כיור)', '🍳', 2, 7],
  ['סלון ושטיפת רצפה', '🧹', 3, 7],
  ['זבל ומחזור', '🗑️', 1, 7],
];
const DEFAULT_INVENTORY = [
  ['נייר טואלט', '🧻'], ['נוזל כלים', '🧴'], ['סבון ידיים', '🧼'], ['שקיות זבל', '🛍️'],
  ['ספוגים', '🧽'], ['אקונומיקה', '🧪'], ['נוזל רצפות', '🪣'], ['מגבות נייר', '🧻'],
];
const DEFAULT_INFO = [
  ['רשת WiFi', ''], ['סיסמת WiFi', ''], ['בעל הבית', ''], ['אינסטלטור', ''], ['חשמלאי', ''], ['ימי פינוי זבל', ''],
];

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  schemaReady = true;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (msg, status = 400) => json({ error: msg }, status);
const uid = () => crypto.randomUUID();
const now = () => Date.now();
const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return [...a].map((b) => chars[b % chars.length]).join('');
}

// Day number (days since epoch) in Israel local time
function todayNum() {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
const dow = (day) => (day + 4) % 7; // 0 = Sunday
function startDayFor(freq) {
  const t = todayNum();
  return freq % 7 === 0 ? t - dow(t) : t;
}

function israelHour() {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hour12: false }).format(new Date()), 10) % 24;
}
function dayOfTs(ts) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(ts));
  const [y, m, d] = s.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
const fmtDay = (n) => { const d = new Date(n * 86400000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };

// ---------- weekly duty (one person per week, passes only when marked done) ----------
async function activeMembers(db, A) {
  return (await db.prepare('SELECT id, name, color, position FROM members WHERE apartment_id=? AND active=1 ORDER BY position').bind(A).all()).results;
}
function nextAfter(members, curId, curPos) {
  const idx = members.findIndex((m) => m.id === curId);
  if (idx >= 0) return members[(idx + 1) % members.length];
  return members.find((m) => m.position > curPos) || members[0];
}
async function ensureDuty(db, A, members) {
  members = members || (await activeMembers(db, A));
  if (!members.length) return null;
  let d = await db.prepare('SELECT * FROM duty WHERE apartment_id=?').bind(A).first();
  if (!d) {
    const t = todayNum();
    const s = t - dow(t);
    await db.prepare('INSERT OR IGNORE INTO duty (apartment_id, member_id, period_start, period_end, started_at) VALUES (?,?,?,?,?)').bind(A, members[0].id, s, s + 6, now()).run();
    d = await db.prepare('SELECT * FROM duty WHERE apartment_id=?').bind(A).first();
  } else if (!members.some((m) => m.id === d.member_id)) {
    const gone = await db.prepare('SELECT position FROM members WHERE id=?').bind(d.member_id).first();
    const nx = nextAfter(members, d.member_id, gone ? gone.position : -1);
    await db.prepare('UPDATE duty SET member_id=? WHERE apartment_id=?').bind(nx.id, A).run();
    d.member_id = nx.id;
  }
  return d;
}

// ---------- web push (VAPID, no payload; the service worker fetches the text) ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function getVapid(db) {
  let row = await db.prepare(`SELECT value FROM kv WHERE key='vapid'`).first();
  if (row) return JSON.parse(row.value);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const raw = await crypto.subtle.exportKey('raw', kp.publicKey);
  await db.prepare(`INSERT OR IGNORE INTO kv (key, value) VALUES ('vapid', ?)`).bind(JSON.stringify({ jwk, pub: b64u(raw) })).run();
  row = await db.prepare(`SELECT value FROM kv WHERE key='vapid'`).first();
  return JSON.parse(row.value);
}
async function vapidHeader(v, endpoint, subject) {
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject });
  const jwk = { ...v.jwk, key_ops: ['sign'] };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${v.pub}`;
}
async function notify(db, memberId, title, body, url, origin) {
  await db.prepare('INSERT INTO notifications (id, member_id, title, body, url, created_at) VALUES (?,?,?,?,?,?)').bind(uid(), memberId, title, body, url || '/', now()).run();
  const subs = (await db.prepare('SELECT endpoint FROM push_subs WHERE member_id=?').bind(memberId).all()).results;
  if (!subs.length) return 0;
  const v = await getVapid(db);
  let sent = 0;
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, {
        method: 'POST',
        headers: { TTL: '86400', Urgency: 'high', Authorization: await vapidHeader(v, s.endpoint, origin || 'mailto:dira@dira.app'), 'Content-Length': '0' },
      });
      if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(s.endpoint).run();
      else if (r.ok) sent++;
    } catch {}
  }
  return sent;
}
// send at most once per member/kind/day
async function notifyOnce(db, memberId, kind, title, body, url, origin) {
  const r = await db.prepare('INSERT OR IGNORE INTO notif_log (member_id, kind, day) VALUES (?,?,?)').bind(memberId, kind, todayNum()).run();
  if (r.meta && r.meta.changes) await notify(db, memberId, title, body, url, origin);
}
async function runReminders(db, A, origin) {
  const h = israelHour();
  if (h < 9 || h >= 22) return;
  const d = await ensureDuty(db, A);
  if (!d) return;
  const t = todayNum();
  if (t < d.period_start) return; // already done, next turn not started yet
  const url = '/?tab=chores';
  if (t > d.period_end) {
    const late = t - d.period_end;
    await notifyOnce(db, d.member_id, 'duty-late', '🧹 התורנות עדיין אצלך',
      `התורנות של השבוע שהתחיל ב־${fmtDay(d.period_start)} באיחור של ${late} ${late === 1 ? 'יום' : 'ימים'}. היא נשארת אצלך עד שתסמן/י "בוצע".`, url, origin);
  } else if (t === d.period_start) {
    await notifyOnce(db, d.member_id, 'duty-start', '🧹 השבוע התורנות אצלך', `התורנות שלך עד ${fmtDay(d.period_end)}. בהצלחה!`, url, origin);
  } else if (dow(t) >= 4) {
    const left = d.period_end - t + 1;
    await notifyOnce(db, d.member_id, 'duty-remind', '⏰ תזכורת תורנות',
      left === 1 ? 'היום היום האחרון של התורנות שלך. אל תשכח/י לסמן "בוצע".' : `נשארו ${left} ימים לתורנות שלך השבוע.`, url, origin);
  }
}

class HttpError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// ---------- image helpers ----------
async function saveImage(db, A, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return null;
  if (m[2].length > 1_400_000) throw new HttpError('התמונה גדולה מדי');
  const id = uid();
  await db.prepare('INSERT INTO images (id, apartment_id, mime, data, created_at) VALUES (?,?,?,?,?)').bind(id, A, m[1], m[2], now()).run();
  return id;
}

// ---------- handlers ----------
async function createApartment(db, body) {
  const aptName = str(body.aptName, 60) || 'הדירה שלנו';
  const memberName = str(body.memberName, 30);
  if (!memberName) throw new HttpError('צריך שם');
  const A = uid();
  let code = inviteCode();
  for (let i = 0; i < 5 && (await db.prepare('SELECT 1 FROM apartments WHERE code=?').bind(code).first()); i++) code = inviteCode();
  const t = now();
  const token = randomHex(24);
  const memberId = uid();
  const sd = startDayFor(7);
  const stmts = [
    db.prepare('INSERT INTO apartments (id,name,code,created_at) VALUES (?,?,?,?)').bind(A, aptName, code, t),
    db.prepare('INSERT INTO members (id,apartment_id,name,color,token,position,created_at) VALUES (?,?,?,?,?,?,?)').bind(memberId, A, memberName, COLORS[0], token, 0, t),
    ...DEFAULT_CHORES.map(([n, i, w, f], idx) =>
      db.prepare('INSERT INTO chores (id,apartment_id,name,icon,weight,freq_days,start_day,offset_,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(uid(), A, n, i, w, f, sd, idx, t)),
    ...DEFAULT_INVENTORY.map(([n, i]) =>
      db.prepare('INSERT INTO inventory (id,apartment_id,name,icon,status,updated_at) VALUES (?,?,?,?,?,?)').bind(uid(), A, n, i, 'ok', t)),
    ...DEFAULT_INFO.map(([l, v], idx) =>
      db.prepare('INSERT INTO info (id,apartment_id,label,value,position) VALUES (?,?,?,?,?)').bind(uid(), A, l, v, idx)),
  ];
  await db.batch(stmts);
  return json({ token, code });
}

async function joinApartment(db, body) {
  const code = str(body.code, 10).toUpperCase();
  const memberName = str(body.memberName, 30);
  if (!memberName) throw new HttpError('צריך שם');
  const apt = await db.prepare('SELECT * FROM apartments WHERE code=?').bind(code).first();
  if (!apt) throw new HttpError('קוד לא נמצא', 404);
  const cnt = await db.prepare('SELECT COUNT(*) c, COALESCE(MAX(position),-1) mx FROM members WHERE apartment_id=?').bind(apt.id).first();
  const activeCnt = await db.prepare('SELECT COUNT(*) c FROM members WHERE apartment_id=? AND active=1').bind(apt.id).first();
  if (activeCnt.c >= 12) throw new HttpError('הדירה מלאה');
  const token = randomHex(24);
  await db.prepare('INSERT INTO members (id,apartment_id,name,color,token,position,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(uid(), apt.id, memberName, COLORS[cnt.c % COLORS.length], token, cnt.mx + 1, now()).run();
  return json({ token });
}

async function getState({ db, me, A, waitUntil, origin }) {
  const t = now();
  const day = todayNum();
  const apt = await db.prepare('SELECT id,name,code FROM apartments WHERE id=?').bind(A).first();
  const members = await activeMembers(db, A);
  const d = await ensureDuty(db, A, members);
  if (waitUntil) waitUntil(runReminders(db, A, origin).catch(() => {}));
  const tasks = (await db.prepare('SELECT id, name, icon FROM chores WHERE apartment_id=? AND active=1 ORDER BY offset_').bind(A).all()).results;
  const logs = (await db.prepare('SELECT * FROM duty_log WHERE apartment_id=? ORDER BY done_at DESC LIMIT 200').bind(A).all()).results;
  const dutyLog = logs.map((l) => ({ ...l, done_day: dayOfTs(l.done_at), late: Math.max(0, dayOfTs(l.done_at) - l.period_end) }));
  const lastLog = dutyLog[0] || null;
  const duty = d ? {
    member_id: d.member_id,
    period_start: d.period_start,
    period_end: d.period_end,
    status: day < d.period_start ? 'upcoming' : day > d.period_end ? 'late' : 'active',
    late_days: Math.max(0, day - d.period_end),
    days_left: d.period_end - day + 1,
    last: lastLog && lastLog.done_at === d.started_at && (day < d.period_start || t - lastLog.done_at < 86400000) ? lastLog : null,
    can_undo: !!(lastLog && lastLog.done_at === d.started_at && t - lastLog.done_at < 12 * 3600000),
  } : null;

  const [shopping, frequent, inventory, notices, issues, info, polls, options, votes, swaps] = await Promise.all([
    db.prepare('SELECT * FROM shopping WHERE apartment_id=? AND cleared=0 ORDER BY urgent DESC, added_at DESC LIMIT 300').bind(A).all(),
    db.prepare('SELECT name, COUNT(*) c FROM shopping WHERE apartment_id=? GROUP BY name ORDER BY c DESC LIMIT 30').bind(A).all(),
    db.prepare('SELECT * FROM inventory WHERE apartment_id=? ORDER BY name').bind(A).all(),
    db.prepare('SELECT * FROM notices WHERE apartment_id=? AND (expires_at IS NULL OR expires_at > ?) ORDER BY pinned DESC, created_at DESC LIMIT 60').bind(A, t).all(),
    db.prepare(`SELECT * FROM issues WHERE apartment_id=? AND (status!='done' OR updated_at > ?) ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, created_at DESC LIMIT 150`).bind(A, t - 60 * 86400000).all(),
    db.prepare('SELECT * FROM info WHERE apartment_id=? ORDER BY position, label').bind(A).all(),
    db.prepare('SELECT * FROM polls WHERE apartment_id=? ORDER BY closed, created_at DESC LIMIT 30').bind(A).all(),
    db.prepare('SELECT o.* FROM poll_options o JOIN polls p ON p.id=o.poll_id WHERE p.apartment_id=? ORDER BY o.position').bind(A).all(),
    db.prepare('SELECT v.* FROM poll_votes v JOIN polls p ON p.id=v.poll_id WHERE p.apartment_id=?').bind(A).all(),
    db.prepare(`SELECT * FROM swaps WHERE apartment_id=? AND status='pending' ORDER BY created_at DESC`).bind(A).all(),
  ]);
  const openNames = new Set(shopping.results.filter((s) => !s.bought_at).map((s) => s.name));

  return json({
    serverTime: t,
    today: day,
    apartment: apt,
    me: { id: me.id, name: me.name, color: me.color },
    members,
    duty,
    tasks,
    dutyLog: dutyLog.slice(0, 30),
    dutyStats: members.map((m) => {
      const mine = dutyLog.filter((l) => l.member_id === m.id);
      return { member_id: m.id, count: mine.length, late: mine.filter((l) => l.late > 0).length };
    }),
    swaps: swaps.results,
    shopping: shopping.results,
    frequent: frequent.results.map((r) => r.name).filter((n) => !openNames.has(n)).slice(0, 16),
    inventory: inventory.results,
    notices: notices.results,
    issues: issues.results,
    info: info.results,
    polls: polls.results.map((p) => ({
      ...p,
      options: options.results.filter((o) => o.poll_id === p.id),
      votes: votes.results.filter((v) => v.poll_id === p.id),
    })),
  });
}

async function own(db, table, id, A) {
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND apartment_id=?`).bind(id, A).first();
  if (!row) throw new HttpError('לא נמצא', 404);
  return row;
}

const routes = [
  ['GET', 'state', getState],

  // members
  ['PATCH', 'me', async ({ db, me, body }) => {
    const name = str(body.name, 30) || me.name;
    const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : me.color;
    await db.prepare('UPDATE members SET name=?, color=? WHERE id=?').bind(name, color, me.id).run();
    return json({ ok: true });
  }],
  ['DELETE', 'members/:id', async ({ db, A, params }) => {
    await db.prepare('UPDATE members SET active=0 WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],
  ['POST', 'members/order', async ({ db, A, body }) => {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    await db.batch(ids.map((id, i) => db.prepare('UPDATE members SET position=? WHERE id=? AND apartment_id=?').bind(i, id, A)));
    return json({ ok: true });
  }],
  ['PATCH', 'apartment', async ({ db, A, body }) => {
    const name = str(body.name, 60);
    if (name) await db.prepare('UPDATE apartments SET name=? WHERE id=?').bind(name, A).run();
    return json({ ok: true });
  }],

  // duty tasks (what the weekly duty includes — reference list, no per-task marking)
  ['POST', 'chores', async ({ db, A, body }) => {
    const name = str(body.name, 60);
    if (!name) throw new HttpError('צריך שם');
    const mx = await db.prepare('SELECT COALESCE(MAX(offset_),-1) mx FROM chores WHERE apartment_id=?').bind(A).first();
    await db.prepare('INSERT INTO chores (id,apartment_id,name,icon,weight,freq_days,start_day,offset_,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid(), A, name, str(body.icon, 8) || '✨', 1, 7, 0, mx.mx + 1, now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'chores/:id', async ({ db, A, body, params }) => {
    const ch = await own(db, 'chores', params.id, A);
    await db.prepare('UPDATE chores SET name=?, icon=? WHERE id=?').bind(str(body.name, 60) || ch.name, str(body.icon, 8) || ch.icon, ch.id).run();
    return json({ ok: true });
  }],
  ['DELETE', 'chores/:id', async ({ db, A, params }) => {
    await db.prepare('UPDATE chores SET active=0 WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],

  // weekly duty
  ['POST', 'duty/done', async ({ db, A, me, body, waitUntil, origin }) => {
    const members = await activeMembers(db, A);
    const d = await ensureDuty(db, A, members);
    if (!d) throw new HttpError('אין שותפים');
    const imageId = await saveImage(db, A, body.image);
    const ts = now();
    const t = todayNum();
    const nx = nextAfter(members, d.member_id, -1);
    const ns = Math.max(t - dow(t) + 7, d.period_end + 1);
    await db.batch([
      db.prepare('INSERT INTO duty_log (id,apartment_id,member_id,period_start,period_end,done_at,done_by,image_id) VALUES (?,?,?,?,?,?,?,?)')
        .bind(uid(), A, d.member_id, d.period_start, d.period_end, ts, me.id, imageId),
      db.prepare('UPDATE duty SET member_id=?, period_start=?, period_end=?, started_at=? WHERE apartment_id=?').bind(nx.id, ns, ns + 6, ts, A),
      db.prepare(`UPDATE swaps SET status='cancelled' WHERE apartment_id=? AND status='pending'`).bind(A),
    ]);
    const doer = members.find((m) => m.id === me.id);
    const whose = d.member_id === me.id ? '' : ` (במקום ${(members.find((m) => m.id === d.member_id) || {}).name || ''})`;
    waitUntil(Promise.all(members.filter((m) => m.id !== me.id).map((m) =>
      notify(db, m.id, m.id === nx.id ? '🧹 התור הבא שלך' : '✨ הדירה נקייה',
        m.id === nx.id ? `${doer.name} סיים/ה את התורנות${whose}. התורנות שלך מתחילה ב־${fmtDay(ns)}.` : `${doer.name} סיים/ה את התורנות${whose}. הבא/ה בתור: ${nx.name}.`,
        '/?tab=chores', origin))).catch(() => {}));
    return json({ ok: true });
  }],
  ['POST', 'duty/undo', async ({ db, A }) => {
    const d = await db.prepare('SELECT * FROM duty WHERE apartment_id=?').bind(A).first();
    const last = await db.prepare('SELECT * FROM duty_log WHERE apartment_id=? ORDER BY done_at DESC LIMIT 1').bind(A).first();
    if (!d || !last || last.done_at !== d.started_at) throw new HttpError('אי אפשר לבטל');
    await db.batch([
      db.prepare('UPDATE duty SET member_id=?, period_start=?, period_end=?, started_at=? WHERE apartment_id=?').bind(last.member_id, last.period_start, last.period_end, now(), A),
      db.prepare('DELETE FROM duty_log WHERE id=?').bind(last.id),
    ]);
    return json({ ok: true });
  }],
  ['PATCH', 'duty', async ({ db, A, body }) => {
    await ensureDuty(db, A);
    await own(db, 'members', body.member_id, A);
    await db.prepare('UPDATE duty SET member_id=? WHERE apartment_id=?').bind(body.member_id, A).run();
    return json({ ok: true });
  }],

  // swaps (whole weekly duty)
  ['POST', 'swaps', async ({ db, A, me, body, waitUntil, origin }) => {
    const d = await ensureDuty(db, A);
    const to = await own(db, 'members', body.to_member, A);
    if (!d || d.member_id !== me.id) throw new HttpError('רק התורן/ית יכול/ה לבקש החלפה');
    if (to.id === me.id) throw new HttpError('אי אפשר להחליף עם עצמך');
    const dup = await db.prepare(`SELECT 1 FROM swaps WHERE apartment_id=? AND status='pending'`).bind(A).first();
    if (dup) throw new HttpError('כבר יש בקשת החלפה פתוחה');
    await db.prepare('INSERT INTO swaps (id,apartment_id,chore_id,period,from_member,to_member,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), A, 'duty', d.period_start, me.id, to.id, now()).run();
    waitUntil(notify(db, to.id, '⇄ בקשת החלפת תורנות', `${me.name} מבקש/ת שתיקח/י את התורנות עכשיו, ובתמורה הוא/היא יעבור/תעבור למקום שלך בסדר.`, '/', origin).catch(() => {}));
    return json({ ok: true });
  }],
  ['POST', 'swaps/:id/accept', async ({ db, A, me, params, waitUntil, origin }) => {
    const sw = await own(db, 'swaps', params.id, A);
    if (sw.to_member !== me.id || sw.status !== 'pending') throw new HttpError('לא ניתן לאשר', 403);
    const a = await own(db, 'members', sw.from_member, A);
    const b = me;
    await db.batch([
      db.prepare(`UPDATE swaps SET status='accepted' WHERE id=?`).bind(sw.id),
      db.prepare('UPDATE members SET position=? WHERE id=?').bind(b.position, a.id),
      db.prepare('UPDATE members SET position=? WHERE id=?').bind(a.position, b.id),
      db.prepare('UPDATE duty SET member_id=? WHERE apartment_id=? AND member_id=?').bind(b.id, A, a.id),
    ]);
    waitUntil(notify(db, a.id, '✓ ההחלפה אושרה', `${b.name} לוקח/ת את התורנות הנוכחית.`, '/', origin).catch(() => {}));
    return json({ ok: true });
  }],
  ['POST', 'swaps/:id/reject', async ({ db, A, me, params }) => {
    const sw = await own(db, 'swaps', params.id, A);
    if (sw.to_member !== me.id && sw.from_member !== me.id) throw new HttpError('אין הרשאה', 403);
    await db.prepare(`UPDATE swaps SET status=? WHERE id=?`).bind(sw.from_member === me.id ? 'cancelled' : 'rejected', sw.id).run();
    return json({ ok: true });
  }],

  // push notifications
  ['GET', 'push/key', async ({ db }) => json({ key: (await getVapid(db)).pub })],
  ['POST', 'push/subscribe', async ({ db, A, me, body }) => {
    const ep = body.subscription && body.subscription.endpoint;
    if (!ep || !/^https:\/\//.test(ep)) throw new HttpError('מנוי לא תקין');
    await db.prepare('INSERT OR REPLACE INTO push_subs (endpoint, member_id, apartment_id, created_at) VALUES (?,?,?,?)').bind(ep, me.id, A, now()).run();
    return json({ ok: true });
  }],
  ['POST', 'push/unsubscribe', async ({ db, me, body }) => {
    await db.prepare('DELETE FROM push_subs WHERE endpoint=? AND member_id=?').bind(String(body.endpoint || ''), me.id).run();
    return json({ ok: true });
  }],
  ['POST', 'push/test', async ({ db, me, origin }) => {
    const sent = await notify(db, me.id, '🔔 ההתראות פעילות', 'מעכשיו תקבל/י כאן תזכורות תורנות ועדכונים מהדירה.', '/', origin);
    return json({ ok: true, sent });
  }],
  ['GET', 'notifications/pending', async ({ db, me }) => {
    const items = (await db.prepare('SELECT id, title, body, url FROM notifications WHERE member_id=? AND seen=0 AND created_at > ? ORDER BY created_at DESC LIMIT 5').bind(me.id, now() - 86400000).all()).results;
    await db.prepare('UPDATE notifications SET seen=1 WHERE member_id=? AND seen=0').bind(me.id).run();
    return json({ items });
  }],

  // shopping
  ['POST', 'shopping', async ({ db, A, me, body }) => {
    const name = str(body.name, 80);
    if (!name) throw new HttpError('צריך שם מוצר');
    await db.prepare('INSERT INTO shopping (id,apartment_id,name,qty,note,kind,urgent,added_by,added_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid(), A, name, str(body.qty, 30) || null, str(body.note, 200) || null, body.kind === 'personal' ? 'personal' : 'shared', body.urgent ? 1 : 0, me.id, now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'shopping/:id', async ({ db, A, me, body, params }) => {
    const it = await own(db, 'shopping', params.id, A);
    const stmts = [];
    if ('bought' in body) {
      if (body.bought) {
        stmts.push(db.prepare('UPDATE shopping SET bought_by=?, bought_at=? WHERE id=?').bind(me.id, now(), it.id));
        if (it.inventory_id) stmts.push(db.prepare(`UPDATE inventory SET status='ok', updated_by=?, updated_at=? WHERE id=?`).bind(me.id, now(), it.inventory_id));
      } else {
        stmts.push(db.prepare('UPDATE shopping SET bought_by=NULL, bought_at=NULL WHERE id=?').bind(it.id));
      }
    }
    if ('name' in body || 'qty' in body || 'note' in body || 'urgent' in body || 'kind' in body) {
      stmts.push(db.prepare('UPDATE shopping SET name=?, qty=?, note=?, urgent=?, kind=? WHERE id=?').bind(
        str(body.name, 80) || it.name,
        'qty' in body ? str(body.qty, 30) || null : it.qty,
        'note' in body ? str(body.note, 200) || null : it.note,
        'urgent' in body ? (body.urgent ? 1 : 0) : it.urgent,
        'kind' in body ? (body.kind === 'personal' ? 'personal' : 'shared') : it.kind,
        it.id));
    }
    if (stmts.length) await db.batch(stmts);
    return json({ ok: true });
  }],
  ['DELETE', 'shopping/:id', async ({ db, A, params }) => {
    await db.prepare('DELETE FROM shopping WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],
  ['POST', 'shopping/clear', async ({ db, A }) => {
    await db.prepare('UPDATE shopping SET cleared=1 WHERE apartment_id=? AND bought_at IS NOT NULL').bind(A).run();
    return json({ ok: true });
  }],
  ['POST', 'store', async ({ db, A, me, body, waitUntil, origin }) => {
    await db.prepare(`DELETE FROM notices WHERE apartment_id=? AND author=? AND kind='store'`).bind(A, me.id).run();
    if (body.on) {
      await db.prepare('INSERT INTO notices (id,apartment_id,text,kind,author,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uid(), A, str(body.text, 100) || 'בסופר עכשיו', 'store', me.id, now(), now() + 90 * 60000).run();
      const others = (await activeMembers(db, A)).filter((m) => m.id !== me.id);
      waitUntil(Promise.all(others.map((m) => notifyOnce(db, m.id, 'store-' + me.id, `🛒 ${me.name} בסופר עכשיו`, 'חסר משהו? זה הזמן להוסיף לרשימת הקניות.', '/?tab=shop', origin))).catch(() => {}));
    }
    return json({ ok: true });
  }],

  // inventory
  ['POST', 'inventory', async ({ db, A, me, body }) => {
    const name = str(body.name, 60);
    if (!name) throw new HttpError('צריך שם');
    await db.prepare('INSERT INTO inventory (id,apartment_id,name,icon,status,updated_by,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), A, name, str(body.icon, 8) || '📦', 'ok', me.id, now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'inventory/:id', async ({ db, A, me, body, params }) => {
    const inv = await own(db, 'inventory', params.id, A);
    const status = ['ok', 'low', 'out'].includes(body.status) ? body.status : inv.status;
    const stmts = [db.prepare('UPDATE inventory SET status=?, updated_by=?, updated_at=? WHERE id=?').bind(status, me.id, now(), inv.id)];
    if (status === 'ok') {
      // back in stock → drop the auto-added item that hasn't been bought yet
      stmts.push(db.prepare('DELETE FROM shopping WHERE inventory_id=? AND bought_at IS NULL AND cleared=0').bind(inv.id));
    } else {
      const open =await db.prepare('SELECT id FROM shopping WHERE inventory_id=? AND bought_at IS NULL AND cleared=0').bind(inv.id).first();
      if (open) {
        stmts.push(db.prepare('UPDATE shopping SET urgent=? WHERE id=?').bind(status === 'out' ? 1 : 0, open.id));
      } else {
        stmts.push(db.prepare('INSERT INTO shopping (id,apartment_id,name,note,kind,urgent,added_by,added_at,inventory_id) VALUES (?,?,?,?,?,?,?,?,?)')
          .bind(uid(), A, inv.name, status === 'out' ? 'נגמר' : 'עומד להיגמר', 'shared', status === 'out' ? 1 : 0, me.id, now(), inv.id));
      }
    }
    await db.batch(stmts);
    return json({ ok: true });
  }],
  ['DELETE', 'inventory/:id', async ({ db, A, params }) => {
    await db.prepare('DELETE FROM inventory WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],

  // notices
  ['POST', 'notices', async ({ db, A, me, body }) => {
    const text = str(body.text, 1000);
    if (!text) throw new HttpError('הודעה ריקה');
    await db.prepare('INSERT INTO notices (id,apartment_id,text,kind,pinned,author,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), A, text, 'note', body.pinned ? 1 : 0, me.id, now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'notices/:id', async ({ db, A, body, params }) => {
    await db.prepare('UPDATE notices SET pinned=? WHERE id=? AND apartment_id=?').bind(body.pinned ? 1 : 0, params.id, A).run();
    return json({ ok: true });
  }],
  ['DELETE', 'notices/:id', async ({ db, A, params }) => {
    await db.prepare('DELETE FROM notices WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],

  // issues
  ['POST', 'issues', async ({ db, A, me, body }) => {
    const title = str(body.title, 100);
    if (!title) throw new HttpError('צריך כותרת');
    const imageId = await saveImage(db, A, body.image);
    await db.prepare('INSERT INTO issues (id,apartment_id,title,description,landlord,image_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid(), A, title, str(body.description, 2000) || null, body.landlord ? 1 : 0, imageId, me.id, now(), now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'issues/:id', async ({ db, A, body, params }) => {
    const is = await own(db, 'issues', params.id, A);
    const status = ['open', 'in_progress', 'done'].includes(body.status) ? body.status : is.status;
    const landlord = 'landlord' in body ? (body.landlord ? 1 : 0) : is.landlord;
    const assignee = 'assignee' in body ? body.assignee || null : is.assignee;
    await db.prepare('UPDATE issues SET status=?, landlord=?, assignee=?, updated_at=? WHERE id=?').bind(status, landlord, assignee, now(), is.id).run();
    return json({ ok: true });
  }],
  ['DELETE', 'issues/:id', async ({ db, A, params }) => {
    await db.prepare('DELETE FROM issues WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],

  // info
  ['POST', 'info', async ({ db, A, body }) => {
    const label = str(body.label, 60);
    if (!label) throw new HttpError('צריך כותרת');
    const mx = await db.prepare('SELECT COALESCE(MAX(position),-1) mx FROM info WHERE apartment_id=?').bind(A).first();
    await db.prepare('INSERT INTO info (id,apartment_id,label,value,position) VALUES (?,?,?,?,?)').bind(uid(), A, label, str(body.value, 500), mx.mx + 1).run();
    return json({ ok: true });
  }],
  ['PATCH', 'info/:id', async ({ db, A, body, params }) => {
    const it = await own(db, 'info', params.id, A);
    await db.prepare('UPDATE info SET label=?, value=? WHERE id=?').bind(str(body.label, 60) || it.label, 'value' in body ? str(body.value, 500) : it.value, it.id).run();
    return json({ ok: true });
  }],
  ['DELETE', 'info/:id', async ({ db, A, params }) => {
    await db.prepare('DELETE FROM info WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],

  // polls
  ['POST', 'polls', async ({ db, A, me, body }) => {
    const q = str(body.question, 200);
    const opts = (Array.isArray(body.options) ? body.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 8);
    if (!q || opts.length < 2) throw new HttpError('צריך שאלה ולפחות שתי אפשרויות');
    const pid = uid();
    await db.batch([
      db.prepare('INSERT INTO polls (id,apartment_id,question,created_by,created_at) VALUES (?,?,?,?,?)').bind(pid, A, q, me.id, now()),
      ...opts.map((o, i) => db.prepare('INSERT INTO poll_options (id,poll_id,text,position) VALUES (?,?,?,?)').bind(uid(), pid, o, i)),
    ]);
    return json({ ok: true });
  }],
  ['POST', 'polls/:id/vote', async ({ db, A, me, body, params }) => {
    const p = await own(db, 'polls', params.id, A);
    if (p.closed) throw new HttpError('הסקר סגור');
    const opt = await db.prepare('SELECT id FROM poll_options WHERE id=? AND poll_id=?').bind(body.option_id, p.id).first();
    if (!opt) throw new HttpError('אפשרות לא קיימת');
    await db.prepare('INSERT OR REPLACE INTO poll_votes (poll_id,member_id,option_id) VALUES (?,?,?)').bind(p.id, me.id, opt.id).run();
    return json({ ok: true });
  }],
  ['POST', 'polls/:id/close', async ({ db, A, params }) => {
    await db.prepare('UPDATE polls SET closed=1 WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],
  ['DELETE', 'polls/:id', async ({ db, A, params }) => {
    await own(db, 'polls', params.id, A);
    await db.batch([
      db.prepare('DELETE FROM poll_votes WHERE poll_id=?').bind(params.id),
      db.prepare('DELETE FROM poll_options WHERE poll_id=?').bind(params.id),
      db.prepare('DELETE FROM polls WHERE id=?').bind(params.id),
    ]);
    return json({ ok: true });
  }],

  // images
  ['GET', 'images/:id', async ({ db, A, params }) => {
    const img = await db.prepare('SELECT mime, data FROM images WHERE id=? AND apartment_id=?').bind(params.id, A).first();
    if (!img) return fail('לא נמצא', 404);
    const bin = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': img.mime, 'cache-control': 'private, max-age=31536000, immutable' } });
  }],
];

function match(pattern, seg) {
  const ps = pattern.split('/');
  if (ps.length !== seg.length) return null;
  const params = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(':')) params[ps[i].slice(1)] = decodeURIComponent(seg[i]);
    else if (ps[i] !== seg[i]) return null;
  }
  return params;
}

export async function onRequest({ request, env, params, waitUntil }) {
  try {
    const db = env.DB;
    if (!db) return fail('חסר חיבור למסד הנתונים (D1 binding בשם DB)', 500);
    await ensureSchema(db);
    const url = new URL(request.url);
    const seg = Array.isArray(params.path) ? params.path : params.path ? [params.path] : [];
    const method = request.method;
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await request.json().catch(() => ({})) : {};

    if (method === 'POST' && seg.join('/') === 'apartments') return await createApartment(db, body);
    if (method === 'POST' && seg.join('/') === 'join') return await joinApartment(db, body);
    const origin = url.origin;
    const wu = (p) => { try { waitUntil(p); } catch { /* ignore */ } };
    if (seg.join('/') === 'cron') {
      const apts = (await db.prepare('SELECT id FROM apartments').all()).results;
      for (const a of apts) { try { await runReminders(db, a.id, origin); } catch {} }
      return json({ ok: true, apartments: apts.length });
    }
    if (method === 'GET' && seg[0] === 'invite' && seg[1]) {
      const apt = await db.prepare('SELECT name FROM apartments WHERE code=?').bind(seg[1].toUpperCase()).first();
      return apt ? json({ name: apt.name }) : fail('קוד לא נמצא', 404);
    }

    const token = request.headers.get('x-token') || url.searchParams.get('t');
    const me = token ? await db.prepare('SELECT * FROM members WHERE token=? AND active=1').bind(token).first() : null;
    if (!me) return fail('לא מחובר', 401);

    for (const [m, pattern, handler] of routes) {
      if (m !== method) continue;
      const p = match(pattern, seg);
      if (p) return await handler({ db, me, A: me.apartment_id, body, params: p, url, origin, waitUntil: wu });
    }
    return fail('לא נמצא', 404);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    return fail('שגיאת שרת: ' + (e && e.message), 500);
  }
}
