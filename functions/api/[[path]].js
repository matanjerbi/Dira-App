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

// ---------- chore rotation ----------
async function loadRotation(db, A) {
  const members = (await db.prepare('SELECT id, name, color, position FROM members WHERE apartment_id=? AND active=1 ORDER BY position').bind(A).all()).results;
  const chores = (await db.prepare('SELECT * FROM chores WHERE apartment_id=? AND active=1 ORDER BY offset_').bind(A).all()).results;
  const ov = (await db.prepare('SELECT o.* FROM chore_overrides o JOIN chores c ON c.id=o.chore_id WHERE c.apartment_id=?').bind(A).all()).results;
  const overrides = new Map(ov.map((o) => [o.chore_id + ':' + o.period, o.member_id]));
  return { members, chores, overrides };
}
function assigneeOf(ch, p, rot) {
  const o = rot.overrides.get(ch.id + ':' + p);
  if (o && rot.members.some((m) => m.id === o)) return o;
  const n = rot.members.length;
  if (!n) return null;
  return rot.members[(((p + ch.offset_) % n) + n) % n].id;
}
const periodOf = (ch, day) => Math.floor((day - ch.start_day) / ch.freq_days);
const rangeOf = (ch, p) => ({ start: ch.start_day + p * ch.freq_days, end: ch.start_day + p * ch.freq_days + ch.freq_days - 1 });

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

async function getState({ db, me, A }) {
  const t = now();
  const day = todayNum();
  const apt = await db.prepare('SELECT id,name,code FROM apartments WHERE id=?').bind(A).first();
  const rot = await loadRotation(db, A);
  const dones = (await db.prepare('SELECT d.* FROM chore_done d JOIN chores c ON c.id=d.chore_id WHERE c.apartment_id=? AND d.done_at > ?').bind(A, t - 120 * 86400000).all()).results;
  const doneMap = new Map(dones.map((d) => [d.chore_id + ':' + d.period, d]));

  const chores = rot.chores.map((ch) => {
    const p = periodOf(ch, day);
    const cur = { period: p, ...rangeOf(ch, p), assignee: assigneeOf(ch, p, rot), done: doneMap.get(ch.id + ':' + p) || null };
    let overdue = null;
    if (p > 0 && !doneMap.get(ch.id + ':' + (p - 1))) {
      overdue = { period: p - 1, ...rangeOf(ch, p - 1), assignee: assigneeOf(ch, p - 1, rot) };
    }
    const upcoming = [];
    for (let i = 1; i <= 6; i++) upcoming.push({ period: p + i, ...rangeOf(ch, p + i), assignee: assigneeOf(ch, p + i, rot) });
    return { id: ch.id, name: ch.name, icon: ch.icon, weight: ch.weight, freq_days: ch.freq_days, current: cur, overdue, upcoming };
  });

  const monthStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date()).slice(0, 7);
  const [yy, mm] = monthStr.split('-').map(Number);
  const monthStart = Date.UTC(yy, mm - 1, 1) - 3 * 3600000; // ~Israel midnight
  const statsRows = (await db.prepare(
    `SELECT d.member_id, COUNT(*) cnt, SUM(c.weight) pts FROM chore_done d JOIN chores c ON c.id=d.chore_id
     WHERE c.apartment_id=? AND d.done_at >= ? GROUP BY d.member_id`).bind(A, monthStart).all()).results;
  const recentDone = (await db.prepare(
    `SELECT d.chore_id, d.member_id, d.done_at, d.image_id, c.name, c.icon FROM chore_done d JOIN chores c ON c.id=d.chore_id
     WHERE c.apartment_id=? ORDER BY d.done_at DESC LIMIT 25`).bind(A).all()).results;

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
    members: rot.members,
    chores,
    stats: statsRows,
    recentDone,
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

  // chores
  ['POST', 'chores', async ({ db, A, body }) => {
    const name = str(body.name, 60);
    if (!name) throw new HttpError('צריך שם למטלה');
    const freq = Math.min(Math.max(parseInt(body.freq_days) || 7, 1), 60);
    const weight = Math.min(Math.max(parseInt(body.weight) || 1, 1), 5);
    const mx = await db.prepare('SELECT COALESCE(MAX(offset_),-1) mx FROM chores WHERE apartment_id=?').bind(A).first();
    await db.prepare('INSERT INTO chores (id,apartment_id,name,icon,weight,freq_days,start_day,offset_,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(uid(), A, name, str(body.icon, 8) || '✨', weight, freq, startDayFor(freq), mx.mx + 1, now()).run();
    return json({ ok: true });
  }],
  ['PATCH', 'chores/:id', async ({ db, A, body, params }) => {
    const ch = await own(db, 'chores', params.id, A);
    const name = str(body.name, 60) || ch.name;
    const icon = str(body.icon, 8) || ch.icon;
    const weight = body.weight ? Math.min(Math.max(parseInt(body.weight), 1), 5) : ch.weight;
    const freq = body.freq_days ? Math.min(Math.max(parseInt(body.freq_days), 1), 60) : ch.freq_days;
    const stmts = [];
    if (freq !== ch.freq_days) {
      stmts.push(db.prepare('UPDATE chores SET freq_days=?, start_day=? WHERE id=?').bind(freq, startDayFor(freq), ch.id));
      stmts.push(db.prepare('DELETE FROM chore_overrides WHERE chore_id=?').bind(ch.id));
    }
    stmts.push(db.prepare('UPDATE chores SET name=?, icon=?, weight=? WHERE id=?').bind(name, icon, weight, ch.id));
    await db.batch(stmts);
    return json({ ok: true });
  }],
  ['DELETE', 'chores/:id', async ({ db, A, params }) => {
    await db.prepare('UPDATE chores SET active=0 WHERE id=? AND apartment_id=?').bind(params.id, A).run();
    return json({ ok: true });
  }],
  ['POST', 'chores/:id/done', async ({ db, A, me, body, params }) => {
    const ch = await own(db, 'chores', params.id, A);
    const period = Number.isInteger(body.period) ? body.period : periodOf(ch, todayNum());
    const imageId = await saveImage(db, A, body.image);
    await db.prepare('INSERT OR REPLACE INTO chore_done (chore_id,period,member_id,done_at,image_id) VALUES (?,?,?,?,?)')
      .bind(ch.id, period, me.id, now(), imageId).run();
    return json({ ok: true });
  }],
  ['DELETE', 'chores/:id/done/:period', async ({ db, A, params }) => {
    await own(db, 'chores', params.id, A);
    await db.prepare('DELETE FROM chore_done WHERE chore_id=? AND period=?').bind(params.id, parseInt(params.period)).run();
    return json({ ok: true });
  }],
  ['POST', 'chores/:id/assign', async ({ db, A, body, params }) => {
    await own(db, 'chores', params.id, A);
    await own(db, 'members', body.member_id, A);
    await db.prepare('INSERT OR REPLACE INTO chore_overrides (chore_id,period,member_id) VALUES (?,?,?)').bind(params.id, parseInt(body.period), body.member_id).run();
    return json({ ok: true });
  }],

  // swaps
  ['POST', 'swaps', async ({ db, A, me, body }) => {
    const ch = await own(db, 'chores', body.chore_id, A);
    await own(db, 'members', body.to_member, A);
    if (body.to_member === me.id) throw new HttpError('אי אפשר להחליף עם עצמך');
    const period = parseInt(body.period);
    const dup = await db.prepare(`SELECT 1 FROM swaps WHERE chore_id=? AND period=? AND status='pending'`).bind(ch.id, period).first();
    if (dup) throw new HttpError('כבר יש בקשת החלפה פתוחה לתור הזה');
    await db.prepare('INSERT INTO swaps (id,apartment_id,chore_id,period,from_member,to_member,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), A, ch.id, period, me.id, body.to_member, now()).run();
    return json({ ok: true });
  }],
  ['POST', 'swaps/:id/accept', async ({ db, A, me, params }) => {
    const sw = await own(db, 'swaps', params.id, A);
    if (sw.to_member !== me.id || sw.status !== 'pending') throw new HttpError('לא ניתן לאשר', 403);
    const rot = await loadRotation(db, A);
    const ch = rot.chores.find((c) => c.id === sw.chore_id);
    const stmts = [
      db.prepare(`UPDATE swaps SET status='accepted' WHERE id=?`).bind(sw.id),
      db.prepare('INSERT OR REPLACE INTO chore_overrides (chore_id,period,member_id) VALUES (?,?,?)').bind(sw.chore_id, sw.period, sw.to_member),
    ];
    if (ch) {
      // give the requester the next turn that was the accepter's
      for (let p = sw.period + 1; p <= sw.period + rot.members.length * 2 + 2; p++) {
        if (assigneeOf(ch, p, rot) === sw.to_member) {
          stmts.push(db.prepare('INSERT OR REPLACE INTO chore_overrides (chore_id,period,member_id) VALUES (?,?,?)').bind(sw.chore_id, p, sw.from_member));
          break;
        }
      }
    }
    await db.batch(stmts);
    return json({ ok: true });
  }],
  ['POST', 'swaps/:id/reject', async ({ db, A, me, params }) => {
    const sw = await own(db, 'swaps', params.id, A);
    if (sw.to_member !== me.id && sw.from_member !== me.id) throw new HttpError('אין הרשאה', 403);
    await db.prepare(`UPDATE swaps SET status=? WHERE id=?`).bind(sw.from_member === me.id ? 'cancelled' : 'rejected', sw.id).run();
    return json({ ok: true });
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
  ['POST', 'store', async ({ db, A, me, body }) => {
    await db.prepare(`DELETE FROM notices WHERE apartment_id=? AND author=? AND kind='store'`).bind(A, me.id).run();
    if (body.on) {
      await db.prepare('INSERT INTO notices (id,apartment_id,text,kind,author,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .bind(uid(), A, str(body.text, 100) || 'בסופר עכשיו', 'store', me.id, now(), now() + 90 * 60000).run();
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
    if (status !== 'ok') {
      const open = await db.prepare('SELECT id FROM shopping WHERE inventory_id=? AND bought_at IS NULL AND cleared=0').bind(inv.id).first();
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

export async function onRequest({ request, env, params }) {
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
      if (p) return await handler({ db, me, A: me.apartment_id, body, params: p, url });
    }
    return fail('לא נמצא', 404);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    return fail('שגיאת שרת: ' + (e && e.message), 500);
  }
}
