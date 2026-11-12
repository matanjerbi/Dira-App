/* Dira — ניהול דירת שותפים */
(() => {
  'use strict';

  // ---------- state ----------
  const LS = 'dira.token';
  const S = {
    token: localStorage.getItem(LS),
    data: null,
    raw: '',
    tab: 'home',
    sub: { chores: 'now', shop: 'list', issues: 'active', more: 'polls' },
    shopFilter: 'all',
    draft: { name: '', qty: '', note: '', kind: 'shared', urgent: false, opts: false, notice: '', pinned: false },
    invEdit: false,
    pendingRender: false,
    onb: { mode: 'create', code: '', aptName: '', memberName: '', invitedTo: '' },
  };

  const $app = document.getElementById('app');
  const $sheet = document.getElementById('sheet-root');
  const $toast = document.getElementById('toast');

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
  const fmtDay = (n) => { const d = new Date(n * 86400000); return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`; };
  const dayName = (n) => DAYS[(n + 4) % 7];
  function rel(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'עכשיו';
    if (s < 3600) return `לפני ${Math.floor(s / 60)} דק׳`;
    if (s < 86400) return `לפני ${Math.floor(s / 3600)} שע׳`;
    const d = Math.floor(s / 86400);
    if (d === 1) return 'אתמול';
    if (d < 7) return `לפני ${d} ימים`;
    const dt = new Date(ts);
    return `${dt.getDate()}/${dt.getMonth() + 1}`;
  }
  function freqLabel(f) {
    return { 1: 'כל יום', 2: 'כל יומיים', 3: 'כל 3 ימים', 7: 'שבועי', 14: 'דו־שבועי', 28: 'חודשי', 30: 'חודשי' }[f] || `כל ${f} ימים`;
  }
  function periodLabel(r, f) {
    if (f === 1) return `${dayName(r.start)} ${fmtDay(r.start)}`;
    return `${fmtDay(r.start)}–${fmtDay(r.end)}`;
  }
  const D = () => S.data;
  const me = () => S.data.me;
  function M(id) {
    return S.data.members.find((m) => m.id === id) || { id, name: 'שותף לשעבר', color: '#9aa3b2' };
  }
  const nm = (id) => (id === me().id ? `${M(id).name} (אני)` : M(id).name);
  function initials(m) {
    const n = (m.name || '?').trim();
    const clash = S.data && S.data.members.some((o) => o.id !== m.id && (o.name || '').trim()[0] === n[0]);
    return clash ? n.slice(0, 2) : n[0] || '?';
  }
  const av = (id, cls = '') => { const m = M(id); return `<span class="av ${cls}" style="background:${esc(m.color)};${cls === 'sm' ? 'font-size:9.5px' : ''}" title="${esc(m.name)}">${esc(initials(m))}</span>`; };
  const who = (id, cls = 'sm') => `<span class="who">${av(id, cls)}<span>${esc(nm(id))}</span></span>`;
  const imgUrl = (id) => `/api/images/${encodeURIComponent(id)}?t=${encodeURIComponent(S.token)}`;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => $toast.classList.remove('show'), 2200);
  }
  const phoneLike = (v) => /^[+\d][\d\s\-()]{6,}$/.test(v || '');

  // ---------- api ----------
  async function api(method, path, body) {
    const r = await fetch('/api/' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(S.token ? { 'x-token': S.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && S.token) { logout(true); throw new Error('נותקת מהדירה'); }
    if (!r.ok) throw new Error(j.error || 'שגיאה');
    return j;
  }
  async function act(method, path, body, okMsg) {
    try {
      await api(method, path, body);
      if (okMsg) toast(okMsg);
      await refresh(true);
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }
  async function refresh(force) {
    if (!S.token) return;
    try {
      const j = await api('GET', 'state');
      const raw = JSON.stringify(j);
      if (!force && raw === S.raw) return;
      S.raw = raw;
      S.data = j;
      const ae = document.activeElement;
      if (!force && ae && $app.contains(ae) && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) { S.pendingRender = true; return; }
      render();
    } catch (e) {
      if (!S.data) $app.innerHTML = `<div class="onb"><div class="logo">📡</div><p class="lead">${esc(e.message)}</p><button class="btn primary block" data-a="reload">נסה שוב</button></div>`;
    }
  }
  function logout(silent) {
    localStorage.removeItem(LS);
    S.token = null; S.data = null; S.raw = '';
    closeSheet();
    if (!silent) toast('התנתקת');
    render();
  }

  // ---------- images ----------
  function pickImage() {
    return new Promise((res) => {
      const i = document.createElement('input');
      i.type = 'file';
      i.accept = 'image/*';
      i.onchange = async () => {
        const f = i.files && i.files[0];
        if (!f) return res(null);
        try { res(await compress(f)); } catch { toast('לא הצלחתי לקרוא את התמונה'); res(null); }
      };
      i.click();
    });
  }
  async function compress(file, max = 1100, q = 0.72) {
    const url = URL.createObjectURL(file);
    const img = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = url; });
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    return c.toDataURL('image/jpeg', q);
  }
  function viewImage(id) {
    const v = document.createElement('div');
    v.className = 'viewer';
    v.innerHTML = `<img src="${imgUrl(id)}" alt="">`;
    v.onclick = () => v.remove();
    document.body.appendChild(v);
  }

  // ---------- sheet ----------
  let sheetCtx = {};
  function openSheet(html, ctx = {}) {
    sheetCtx = ctx;
    $sheet.innerHTML = `<div class="sheet-bg" data-a="sheet-bg"><div class="sheet" role="dialog"><div class="grab"></div>${html}</div></div>`;
    const f = $sheet.querySelector('[autofocus]');
    if (f) setTimeout(() => f.focus(), 60);
  }
  function closeSheet() {
    $sheet.innerHTML = '';
    sheetCtx = {};
    if (S.pendingRender) { S.pendingRender = false; render(); }
  }
  const val = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };

  // ---------- render ----------
  function render() {
    if (!S.token || !S.data) { if (!S.token) renderOnboarding(); return; }
    const d = D();
    const myOpen = d.chores.filter((c) => (c.current.assignee === me().id && !c.current.done) || (c.overdue && c.overdue.assignee === me().id)).length;
    const swapsToMe = d.swaps.filter((s) => s.to_member === me().id).length;
    const urgent = d.shopping.filter((s) => !s.bought_at && s.urgent).length;
    const openIssues = d.issues.filter((i) => i.status !== 'done').length;
    const unvoted = d.polls.filter((p) => !p.closed && !p.votes.some((v) => v.member_id === me().id)).length;
    const tabs = [
      ['home', '🏠', 'בית', swapsToMe],
      ['chores', '🧹', 'ניקיונות', myOpen],
      ['shop', '🛒', 'קניות', urgent],
      ['issues', '🔧', 'תקלות', 0],
      ['more', '☰', 'עוד', unvoted],
    ];
    const titles = { home: d.apartment.name, chores: 'תורנות ניקיונות', shop: 'קניות', issues: 'תקלות ותחזוקה', more: 'עוד' };
    let body = '';
    if (S.tab === 'home') body = viewHome();
    if (S.tab === 'chores') body = viewChores();
    if (S.tab === 'shop') body = viewShop();
    if (S.tab === 'issues') body = viewIssues(openIssues);
    if (S.tab === 'more') body = viewMore();
    const scroll = window.scrollY;
    $app.innerHTML = `
      <header class="top">
        <div><h1>${esc(titles[S.tab])}</h1>${S.tab === 'home' ? `<div class="sub">${esc(greeting())}, ${esc(me().name)}</div>` : ''}</div>
        <button class="icon-btn" data-a="tab" data-tab="more" data-sub="settings" aria-label="הגדרות">${av(me().id)}</button>
      </header>
      <main>${body}</main>
      <nav class="bottom">${tabs.map(([k, ic, l, b]) => `<button class="${S.tab === k ? 'on' : ''}" data-a="tab" data-tab="${k}"><span class="ic">${ic}</span>${l}${b ? `<span class="badge">${b}</span>` : ''}</button>`).join('')}</nav>
      ${S.tab === 'issues' ? `<button class="fab" data-a="issue-new" aria-label="תקלה חדשה">+</button>` : ''}
    `;
    window.scrollTo(0, scroll);
  }
  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'לילה טוב';
    if (h < 12) return 'בוקר טוב';
    if (h < 17) return 'צהריים טובים';
    if (h < 21) return 'ערב טוב';
    return 'לילה טוב';
  }

  // ---------- onboarding ----------
  function renderOnboarding() {
    const o = S.onb;
    $app.innerHTML = `
      <div class="onb">
        <div class="logo">🏠</div>
        <h1>Dira</h1>
        <p class="lead">תורנויות, קניות ותקלות. כל הדירה במקום אחד.</p>
        ${o.invitedTo ? `<div class="card" style="text-align:center">הוזמנת לדירה <b>${esc(o.invitedTo)}</b></div>` : ''}
        <div class="seg">
          <button class="${o.mode === 'join' ? 'on' : ''}" data-a="onb-mode" data-mode="join">הצטרפות לדירה</button>
          <button class="${o.mode === 'create' ? 'on' : ''}" data-a="onb-mode" data-mode="create">דירה חדשה</button>
        </div>
        <div class="card">
          ${o.mode === 'create' ? `
            <div class="field"><label>שם הדירה</label><input class="input" id="o-apt" placeholder="למשל: הדירה בביאליק" value="${esc(o.aptName)}" maxlength="60"></div>
          ` : `
            <div class="field"><label>קוד הזמנה</label><input class="input code" id="o-code" placeholder="ABC123" value="${esc(o.code)}" maxlength="6" autocapitalize="characters" style="font-size:20px"></div>
          `}
          <div class="field"><label>השם שלך</label><input class="input" id="o-name" placeholder="איך השותפים קוראים לך" value="${esc(o.memberName)}" maxlength="30"></div>
          <button class="btn primary block" data-a="onb-go">${o.mode === 'create' ? 'יצירת הדירה' : 'הצטרפות'}</button>
        </div>
        <p class="muted small" style="text-align:center">באייפון: אחרי הכניסה לחצו על "שיתוף" ואז "הוספה למסך הבית", וזה יעבוד כמו אפליקציה.</p>
      </div>`;
  }

  // ---------- home ----------
  function storeBanners() {
    const d = D();
    return d.notices.filter((n) => n.kind === 'store' && n.author !== me().id).map((n) => `
      <div class="store-banner">
        <div style="font-size:30px">🛒</div>
        <div class="grow"><b>${esc(M(n.author).name)} בסופר עכשיו</b><div class="small" style="opacity:.9">חסר משהו? זה הזמן להוסיף לרשימה</div></div>
        <button class="btn sm" data-a="tab" data-tab="shop" data-sub="list">להוסיף</button>
      </div>`).join('');
  }
  function swapCards() {
    const d = D();
    return d.swaps.filter((s) => s.to_member === me().id).map((s) => {
      const c = d.chores.find((x) => x.id === s.chore_id);
      if (!c) return '';
      const r = { start: 0, end: 0 };
      const diff = s.period - c.current.period;
      r.start = c.current.start + diff * c.freq_days; r.end = r.start + c.freq_days - 1;
      return `<div class="card" style="outline:2px solid var(--warn);outline-offset:-2px">
        <div class="row">${av(s.from_member)}<div class="grow"><b>${esc(M(s.from_member).name)}</b> מבקש/ת להחליף איתך תור
        <div class="small muted">${c.icon || ''} ${esc(c.name)} · ${periodLabel(r, c.freq_days)}. בתמורה התור הבא שלך במטלה הזו עובר אליו/ה</div></div></div>
        <div class="row" style="margin-top:10px"><button class="btn primary grow" data-a="swap-accept" data-id="${s.id}">מאשר/ת</button><button class="btn grow" data-a="swap-reject" data-id="${s.id}">לא הפעם</button></div>
      </div>`;
    }).join('');
  }
  function viewHome() {
    const d = D();
    const mine = d.chores.filter((c) => (c.current.assignee === me().id && !c.current.done) || (c.overdue && c.overdue.assignee === me().id));
    const openShop = d.shopping.filter((s) => !s.bought_at);
    const urgent = openShop.filter((s) => s.urgent).length;
    const openIssues = d.issues.filter((i) => i.status !== 'done').length;
    const doneMine = d.chores.filter((c) => c.current.assignee === me().id && c.current.done).length;
    const activePolls = d.polls.filter((p) => !p.closed && !p.votes.some((v) => v.member_id === me().id));
    const notes = d.notices.filter((n) => n.kind === 'note');
    return `
      ${storeBanners()}
      ${swapCards()}
      <div class="section-title">המטלות שלי <button class="link" data-a="tab" data-tab="chores">לכל התורנות</button></div>
      ${mine.length ? mine.map((c) => choreCard(c)).join('') : `<div class="card empty"><span class="big">${doneMine ? '🎉' : '😌'}</span>${doneMine ? 'סיימת את כל המטלות שלך לתקופה הזו' : 'אין לך מטלות בתקופה הזו'}</div>`}
      <div class="hl">
        <div class="stat" data-a="tab" data-tab="shop" data-sub="list"><div class="n">${openShop.length}</div><div class="l">ברשימת הקניות${urgent ? ` · <span style="color:var(--danger)">${urgent} דחוף</span>` : ''}</div></div>
        <div class="stat" data-a="tab" data-tab="issues"><div class="n">${openIssues}</div><div class="l">תקלות פתוחות</div></div>
      </div>
      ${activePolls.length ? `<div class="section-title">סקרים שמחכים לך</div>${activePolls.map(pollCard).join('')}` : ''}
      <div class="section-title">לוח מודעות</div>
      <div class="card">
        <textarea class="input" id="notice-text" data-bind="notice" placeholder="למשל: מגיעים אליי אורחים בשישי / הטכנאי מגיע מחר ב-10" rows="2">${esc(S.draft.notice)}</textarea>
        <div class="row between" style="margin-top:8px">
          <button class="chip ${S.draft.pinned ? 'on' : ''}" data-a="toggle-pin-draft">📌 נעוץ</button>
          <button class="btn primary sm" data-a="notice-add">פרסום</button>
        </div>
      </div>
      ${notes.length ? `<div class="card">${notes.map(noticeRow).join('')}</div>` : ''}
    `;
  }
  function noticeRow(n) {
    return `<div class="notice">
      <div class="row">${av(n.author, 'sm')}<span class="small"><b>${esc(M(n.author).name)}</b> <span class="muted">· ${rel(n.created_at)}</span></span>
      <span class="grow"></span>${n.pinned ? '<span class="tag warn">📌 נעוץ</span>' : ''}
      <button class="icon-btn" data-a="notice-menu" data-id="${n.id}" aria-label="אפשרויות">⋯</button></div>
      <p class="txt">${esc(n.text)}</p>
    </div>`;
  }

  // ---------- chores ----------
  function choreCard(c, opts = {}) {
    const d = D();
    const cur = c.current;
    const mine = cur.assignee === me().id;
    const done = cur.done;
    const pendingSwap = d.swaps.find((s) => s.chore_id === c.id && s.period === cur.period);
    const ov = c.overdue;
    const cls = ['card', mine && !done ? 'mine' : '', ov && !opts.noOverdue ? 'overdue' : ''].join(' ');
    return `<div class="${cls}">
      <div class="chore ${done ? 'done' : ''}">
        <div class="emoji">${done ? '✅' : esc(c.icon || '✨')}</div>
        <div class="grow">
          <div class="title">${esc(c.name)}</div>
          <div class="small muted">${freqLabel(c.freq_days)} · ${periodLabel(cur, c.freq_days)}</div>
          <div class="row wrap" style="gap:6px;margin-top:6px">
            ${cur.assignee ? who(cur.assignee) : '<span class="muted small">אין שותפים</span>'}
            ${done ? `<span class="tag ok">✓ ${esc(M(done.member_id).name)} · ${rel(done.done_at)}</span>` : ''}
            ${pendingSwap ? `<span class="tag warn">⇄ ממתין ל${esc(M(pendingSwap.to_member).name)}</span>` : ''}
          </div>
        </div>
      </div>
      ${ov ? `<div class="row" style="margin-top:10px;background:var(--danger-soft);border-radius:12px;padding:8px 10px">
        <div class="grow small" style="color:var(--danger)">⚠️ לא בוצע בתקופה הקודמת (${periodLabel(ov, c.freq_days)}) · ${esc(M(ov.assignee).name)}</div>
        <button class="btn sm danger" data-a="chore-done" data-id="${c.id}" data-period="${ov.period}">בוצע</button></div>` : ''}
      <div class="row" style="margin-top:10px;gap:6px">
        ${!done ? `
          <button class="btn primary grow" data-a="chore-done" data-id="${c.id}" data-period="${cur.period}">✓ בוצע</button>
          <button class="btn" data-a="chore-done-photo" data-id="${c.id}" data-period="${cur.period}" aria-label="בוצע עם תמונה">📷</button>
          ${mine && !pendingSwap ? `<button class="btn" data-a="swap-ask" data-id="${c.id}" data-period="${cur.period}">⇄ החלפה</button>` : ''}
          ${pendingSwap && pendingSwap.from_member === me().id ? `<button class="btn" data-a="swap-reject" data-id="${pendingSwap.id}">ביטול בקשה</button>` : ''}
        ` : `
          ${done.image_id ? `<button class="btn sm" data-a="view-img" data-id="${done.image_id}">🖼 תמונה</button>` : ''}
          <span class="grow"></span>
          <button class="btn ghost sm" data-a="chore-undo" data-id="${c.id}" data-period="${cur.period}">ביטול סימון</button>
        `}
      </div>
      ${opts.upcoming ? `<div class="upcoming">${c.upcoming.map((u) => `<button class="u" style="border:0;background:none;cursor:pointer" data-a="assign" data-id="${c.id}" data-period="${u.period}">${av(u.assignee, 'sm')}<span>${periodLabel(u, c.freq_days).split('–')[0]}</span></button>`).join('')}</div>` : ''}
    </div>`;
  }
  function viewChores() {
    const d = D();
    const sub = S.sub.chores;
    const seg = `<div class="seg">
      ${[['now', 'עכשיו'], ['plan', 'לוח'], ['stats', 'סטטיסטיקה'], ['manage', 'ניהול']].map(([k, l]) => `<button class="${sub === k ? 'on' : ''}" data-a="sub" data-k="chores" data-v="${k}">${l}</button>`).join('')}
    </div>`;
    if (!d.chores.length && sub !== 'manage') return seg + `<div class="card empty"><span class="big">🧽</span>אין מטלות עדיין<br><br><button class="btn primary" data-a="chore-new">הוספת מטלה</button></div>`;
    if (sub === 'now') {
      const sorted = [...d.chores].sort((a, b) => {
        const sc = (c) => (c.overdue ? 0 : 2) + (c.current.done ? 3 : 0) + (c.current.assignee === me().id ? 0 : 1);
        return sc(a) - sc(b);
      });
      return seg + swapCards() + sorted.map((c) => choreCard(c)).join('');
    }
    if (sub === 'plan') {
      return seg + `<p class="small muted" style="margin:0 4px 10px">לחיצה על תור עתידי מאפשרת לשבץ אותו ידנית למישהו אחר.</p>` +
        d.chores.map((c) => `<div class="card">
          <div class="row"><span style="font-size:22px">${esc(c.icon || '✨')}</span><div class="grow"><b>${esc(c.name)}</b><div class="small muted">${freqLabel(c.freq_days)}</div></div></div>
          <div class="upcoming">
            <button class="u" style="border:0;background:none" data-a="assign" data-id="${c.id}" data-period="${c.current.period}">${av(c.current.assignee)}<span><b>עכשיו</b></span></button>
            ${c.upcoming.map((u) => `<button class="u" style="border:0;background:none;cursor:pointer" data-a="assign" data-id="${c.id}" data-period="${u.period}">${av(u.assignee)}<span>${periodLabel(u, c.freq_days).split('–')[0]}</span></button>`).join('')}
          </div></div>`).join('');
    }
    if (sub === 'stats') {
      const rows = d.members.map((m) => {
        const s = d.stats.find((x) => x.member_id === m.id) || { cnt: 0, pts: 0 };
        return { m, cnt: s.cnt || 0, pts: s.pts || 0 };
      }).sort((a, b) => b.pts - a.pts);
      const max = Math.max(1, ...rows.map((r) => r.pts));
      return seg + `<div class="card"><div class="small muted" style="margin-bottom:10px">החודש · נקודות לפי משקל המטלה</div>
        ${rows.map((r, i) => `<div style="margin-bottom:12px"><div class="row between small" style="margin-bottom:5px"><span class="who">${i === 0 && r.pts ? '👑 ' : ''}${av(r.m.id, 'sm')} ${esc(r.m.name)}</span><span><b>${r.pts}</b> נק׳ · ${r.cnt} מטלות</span></div>
        <div class="bar"><i style="width:${(r.pts / max) * 100}%;background:${esc(r.m.color)}"></i></div></div>`).join('')}
      </div>
      <div class="section-title">בוצע לאחרונה</div>
      <div class="card">${d.recentDone.length ? d.recentDone.map((r) => `<div class="row" style="padding:7px 0">
        <span style="font-size:20px">${esc(r.icon || '✨')}</span><div class="grow"><div>${esc(r.name)}</div><div class="small muted">${esc(M(r.member_id).name)} · ${rel(r.done_at)}</div></div>
        ${r.image_id ? `<button class="icon-btn" data-a="view-img" data-id="${r.image_id}">🖼</button>` : ''}</div>`).join('') : '<div class="empty">עוד לא בוצע כלום</div>'}</div>`;
    }
    // manage
    return seg + `<p class="small muted" style="margin:0 4px 10px">הסבב עובר בין השותפים לפי הסדר שלהם (אפשר לשנות אותו ב"עוד" ואז "שותפים"). לכל מטלה יש נקודת התחלה אחרת, כך שהעומס מתחלק.</p>` +
      d.chores.map((c) => `<div class="card"><div class="row">
        <span style="font-size:24px">${esc(c.icon || '✨')}</span>
        <div class="grow"><b>${esc(c.name)}</b><div class="small muted">${freqLabel(c.freq_days)} · משקל ${c.weight}</div></div>
        <button class="btn sm" data-a="chore-edit" data-id="${c.id}">עריכה</button></div></div>`).join('') +
      `<button class="btn primary block" data-a="chore-new">+ מטלה חדשה</button>`;
  }
  const CHORE_ICONS = ['🚽', '🚿', '🛁', '🍳', '🍽️', '🧹', '🧽', '🪣', '🗑️', '♻️', '🪟', '🛋️', '🧺', '🌿', '🐾', '🧊', '✨'];
  function choreSheet(c) {
    const icon = c ? c.icon : '🧹';
    sheetCtx.icon = icon;
    const freqs = [[1, 'כל יום'], [2, 'כל יומיים'], [3, 'כל 3 ימים'], [7, 'שבועי'], [14, 'דו־שבועי'], [28, 'חודשי']];
    openSheet(`
      <h2>${c ? 'עריכת מטלה' : 'מטלה חדשה'}</h2>
      <div class="field"><label>שם</label><input class="input" id="c-name" value="${esc(c ? c.name : '')}" placeholder="למשל: ניקוי מקרר" maxlength="60" ${c ? '' : 'autofocus'}></div>
      <div class="field"><label>אייקון</label><div class="emoji-pick">${CHORE_ICONS.map((e) => `<button class="${e === icon ? 'on' : ''}" data-a="pick-icon" data-v="${e}">${e}</button>`).join('')}</div></div>
      <div class="field"><label>תדירות</label><select class="input" id="c-freq">${freqs.map(([v, l]) => `<option value="${v}" ${(c ? c.freq_days : 7) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>משקל (כמה המטלה "שווה" בסטטיסטיקה)</label><select class="input" id="c-weight">${[1, 2, 3, 4, 5].map((w) => `<option value="${w}" ${(c ? c.weight : 2) === w ? 'selected' : ''}>${w}${w === 1 ? ' · קלה' : w === 5 ? ' · כבדה' : ''}</option>`).join('')}</select></div>
      ${c ? '<p class="small muted">שינוי תדירות מאפס את הסבב של המטלה הזו.</p>' : ''}
      <button class="btn primary block" data-a="chore-save" data-id="${c ? c.id : ''}">שמירה</button>
      ${c ? `<button class="btn danger block" style="margin-top:8px" data-a="chore-del" data-id="${c.id}">מחיקת מטלה</button>` : ''}
    `, { icon });
  }

  // ---------- shopping ----------
  function viewShop() {
    const sub = S.sub.shop;
    const seg = `<div class="seg">
      <button class="${sub === 'list' ? 'on' : ''}" data-a="sub" data-k="shop" data-v="list">רשימת קניות</button>
      <button class="${sub === 'inv' ? 'on' : ''}" data-a="sub" data-k="shop" data-v="inv">מלאי בבית</button>
    </div>`;
    return seg + (sub === 'list' ? viewShopList() : viewInventory());
  }
  function viewShopList() {
    const d = D();
    const dr = S.draft;
    const iAmAtStore = d.notices.some((n) => n.kind === 'store' && n.author === me().id);
    let open = d.shopping.filter((s) => !s.bought_at);
    const bought = d.shopping.filter((s) => s.bought_at).sort((a, b) => b.bought_at - a.bought_at);
    const f = S.shopFilter;
    if (f === 'shared') open = open.filter((s) => s.kind === 'shared');
    if (f === 'personal') open = open.filter((s) => s.kind === 'personal');
    if (f === 'mine') open = open.filter((s) => s.added_by === me().id);
    return `
      ${storeBanners()}
      <button class="btn block ${iAmAtStore ? 'primary' : ''}" style="margin-bottom:12px" data-a="store-toggle" data-on="${iAmAtStore ? 0 : 1}">${iAmAtStore ? '✓ אני בסופר. לחיצה כשסיימתי' : '🛒 אני יוצא/ת לסופר (כולם יראו)'}</button>
      <div class="card">
        <div class="addbar">
          <input class="input" id="s-name" data-bind="name" placeholder="מה צריך לקנות?" value="${esc(dr.name)}" maxlength="80" enterkeyhint="done">
          <button class="btn primary" data-a="shop-add">הוסף</button>
        </div>
        <div class="row wrap" style="gap:6px;margin-top:8px">
          <button class="chip ${dr.kind === 'shared' ? 'on' : ''}" data-a="draft-kind" data-v="shared">🏠 משותף</button>
          <button class="chip ${dr.kind === 'personal' ? 'on' : ''}" data-a="draft-kind" data-v="personal">👤 בשבילי</button>
          <button class="chip ${dr.urgent ? 'on' : ''}" data-a="draft-urgent">🔥 דחוף</button>
          <button class="chip ${dr.opts ? 'on' : ''}" data-a="draft-opts">＋ כמות/הערה</button>
        </div>
        ${dr.opts ? `<div class="row" style="margin-top:8px;gap:8px">
          <input class="input" style="flex:0 0 32%" data-bind="qty" placeholder="כמות" value="${esc(dr.qty)}" maxlength="30">
          <input class="input grow" data-bind="note" placeholder="הערה (למשל: רק תנובה)" value="${esc(dr.note)}" maxlength="200">
        </div>` : ''}
        ${d.frequent.length ? `<div class="small muted" style="margin:12px 0 6px">הוספה מהירה</div><div class="chips">${d.frequent.map((n) => `<button class="chip" data-a="shop-quick" data-v="${esc(n)}">+ ${esc(n)}</button>`).join('')}</div>` : ''}
      </div>
      <div class="chips" style="margin:4px 2px 10px">
        ${[['all', 'הכל'], ['shared', 'משותף'], ['personal', 'אישי'], ['mine', 'הוספתי']].map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-a="shop-filter" data-v="${k}">${l}</button>`).join('')}
      </div>
      <div class="card">${open.length ? open.map(shopItem).join('') : `<div class="empty"><span class="big">🧺</span>הרשימה ריקה</div>`}</div>
      ${bought.length ? `<div class="section-title">נקנה (${bought.length}) <button class="link" data-a="shop-clear">ניקוי</button></div><div class="card">${bought.map(shopItem).join('')}</div>` : ''}
    `;
  }
  function shopItem(s) {
    return `<div class="item ${s.bought_at ? 'bought' : ''}">
      <button class="check ${s.bought_at ? 'on' : ''}" data-a="shop-toggle" data-id="${s.id}" data-b="${s.bought_at ? 0 : 1}" aria-label="נקנה">${s.bought_at ? '✓' : ''}</button>
      <div class="grow" data-a="shop-edit" data-id="${s.id}" style="cursor:pointer">
        <div class="row wrap" style="gap:6px"><span class="name">${esc(s.name)}</span>${s.qty ? `<span class="tag">${esc(s.qty)}</span>` : ''}${s.urgent && !s.bought_at ? '<span class="tag danger">דחוף</span>' : ''}${s.kind === 'personal' ? `<span class="tag accent">👤 של ${esc(M(s.added_by).name)}</span>` : ''}</div>
        ${s.note ? `<div class="small" style="margin-top:3px">${esc(s.note)}</div>` : ''}
        <div class="small muted" style="margin-top:3px">${s.bought_at ? `נקנה ע״י ${esc(M(s.bought_by).name)} · ${rel(s.bought_at)}` : `${esc(M(s.added_by).name)} הוסיף/ה · ${rel(s.added_at)}`}</div>
      </div>
      ${av(s.bought_at ? s.bought_by : s.added_by, 'sm')}
    </div>`;
  }
  function shopSheet(s) {
    openSheet(`
      <h2>עריכת פריט</h2>
      <div class="field"><label>מוצר</label><input class="input" id="e-name" value="${esc(s.name)}" maxlength="80"></div>
      <div class="row" style="gap:8px"><div class="field" style="flex:0 0 35%"><label>כמות</label><input class="input" id="e-qty" value="${esc(s.qty || '')}" maxlength="30"></div>
      <div class="field grow"><label>הערה</label><input class="input" id="e-note" value="${esc(s.note || '')}" maxlength="200"></div></div>
      <div class="row wrap" style="gap:6px;margin-bottom:14px">
        <button class="chip ${s.kind === 'shared' ? 'on' : ''}" data-a="e-kind" data-v="shared">🏠 משותף</button>
        <button class="chip ${s.kind === 'personal' ? 'on' : ''}" data-a="e-kind" data-v="personal">👤 אישי</button>
        <button class="chip ${s.urgent ? 'on' : ''}" data-a="e-urgent">🔥 דחוף</button>
      </div>
      <p class="small muted">${esc(M(s.added_by).name)} הוסיף/ה ${rel(s.added_at)}</p>
      <button class="btn primary block" data-a="shop-save" data-id="${s.id}">שמירה</button>
      <button class="btn danger block" style="margin-top:8px" data-a="shop-del" data-id="${s.id}">מחיקה</button>
    `, { kind: s.kind, urgent: !!s.urgent });
  }

  const INV_ICONS = ['🧻', '🧴', '🧼', '🛍️', '🧽', '🧪', '🪣', '☕', '🧂', '🫒', '🥛', '🍞', '💡', '🔋', '🧺', '📦'];
  function viewInventory() {
    const d = D();
    const order = { out: 0, low: 1, ok: 2 };
    const items = [...d.inventory].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'he'));
    return `<p class="small muted" style="margin:0 4px 10px">מוצרים משותפים שתמיד צריך בבית. מה שמסומן "עומד להיגמר" או "נגמר" נכנס לרשימת הקניות לבד.</p>
      <div class="inv-grid">${items.map((i) => `<div class="inv">
        <div class="top-row"><span class="em">${esc(i.icon || '📦')}</span><span class="nm">${esc(i.name)}</span>
        ${S.invEdit ? `<button class="icon-btn" data-a="inv-del" data-id="${i.id}" aria-label="מחיקה">✕</button>` : ''}</div>
        <div class="tri">
          <button class="ok ${i.status === 'ok' ? 'on' : ''}" data-a="inv-set" data-id="${i.id}" data-v="ok">יש</button>
          <button class="low ${i.status === 'low' ? 'on' : ''}" data-a="inv-set" data-id="${i.id}" data-v="low">עומד להיגמר</button>
          <button class="out ${i.status === 'out' ? 'on' : ''}" data-a="inv-set" data-id="${i.id}" data-v="out">נגמר</button>
        </div>
        ${i.updated_by ? `<div class="small muted">${esc(M(i.updated_by).name)} · ${rel(i.updated_at)}</div>` : ''}
      </div>`).join('')}</div>
      <div class="row" style="margin-top:12px"><button class="btn primary grow" data-a="inv-new">+ מוצר למלאי</button><button class="btn" data-a="inv-edit">${S.invEdit ? 'סיום' : 'עריכה'}</button></div>`;
  }

  // ---------- issues ----------
  const ISSUE_STATUS = { open: ['פתוחה', 'danger'], in_progress: ['בטיפול', 'warn'], done: ['טופלה', 'ok'] };
  function viewIssues() {
    const d = D();
    const sub = S.sub.issues;
    const list = sub === 'active' ? d.issues.filter((i) => i.status !== 'done') : d.issues;
    return `<div class="seg">
        <button class="${sub === 'active' ? 'on' : ''}" data-a="sub" data-k="issues" data-v="active">פתוחות</button>
        <button class="${sub === 'all' ? 'on' : ''}" data-a="sub" data-k="issues" data-v="all">הכל</button>
      </div>
      ${list.length ? list.map((i) => `<div class="card" data-a="issue-open" data-id="${i.id}" style="cursor:pointer">
        <div class="row" style="align-items:flex-start">
          ${i.image_id ? `<img class="issue-img" src="${imgUrl(i.image_id)}" alt="" loading="lazy">` : `<div class="chore"><div class="emoji">🔧</div></div>`}
          <div class="grow">
            <div class="row wrap" style="gap:6px"><b>${esc(i.title)}</b></div>
            <div class="row wrap" style="gap:6px;margin-top:5px">
              <span class="tag ${ISSUE_STATUS[i.status][1]}">${ISSUE_STATUS[i.status][0]}</span>
              ${i.landlord ? '<span class="tag accent">🏢 בעל הבית</span>' : ''}
              ${i.assignee ? `<span class="tag">אחראי/ת: ${esc(M(i.assignee).name)}</span>` : ''}
            </div>
            <div class="small muted" style="margin-top:5px">${esc(M(i.created_by).name)} · ${rel(i.created_at)}</div>
          </div>
        </div>
      </div>`).join('') : `<div class="card empty"><span class="big">🛠️</span>${sub === 'active' ? 'אין תקלות פתוחות' : 'אין תקלות'}</div>`}`;
  }
  function issueNewSheet() {
    openSheet(`
      <h2>תקלה חדשה</h2>
      <div class="field"><label>מה קרה?</label><input class="input" id="i-title" placeholder="למשל: נזילה מתחת לכיור" maxlength="100" autofocus></div>
      <div class="field"><label>פרטים</label><textarea class="input" id="i-desc" placeholder="אופציונלי" maxlength="2000"></textarea></div>
      <div class="row wrap" style="gap:6px;margin-bottom:12px">
        <button class="chip" data-a="i-landlord">🏢 באחריות בעל הבית</button>
        <button class="chip" data-a="i-photo">📷 תמונה</button>
      </div>
      <div id="i-prev"></div>
      <button class="btn primary block" style="margin-top:10px" data-a="issue-save">פתיחת תקלה</button>
    `, { landlord: false, image: null });
  }
  function issueSheet(i) {
    const d = D();
    openSheet(`
      <h2>${esc(i.title)}</h2>
      ${i.image_id ? `<img class="photo-prev" src="${imgUrl(i.image_id)}" data-a="view-img" data-id="${i.image_id}" alt="">` : ''}
      ${i.description ? `<p style="white-space:pre-wrap">${esc(i.description)}</p>` : ''}
      <p class="small muted">נפתחה ע״י ${esc(M(i.created_by).name)} · ${rel(i.created_at)}</p>
      <div class="field"><label>סטטוס</label><div class="seg" style="margin:0">
        ${Object.entries(ISSUE_STATUS).map(([k, [l]]) => `<button class="${i.status === k ? 'on' : ''}" data-a="issue-set" data-id="${i.id}" data-f="status" data-v="${k}">${l}</button>`).join('')}
      </div></div>
      <div class="field"><label>מי מטפל/ת</label><select class="input" data-a-change="issue-assignee" data-id="${i.id}">
        <option value="">אף אחד עדיין</option>
        ${d.members.map((m) => `<option value="${m.id}" ${i.assignee === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
      </select></div>
      <button class="chip ${i.landlord ? 'on' : ''}" style="margin-bottom:14px" data-a="issue-set" data-id="${i.id}" data-f="landlord" data-v="${i.landlord ? 0 : 1}">🏢 באחריות בעל הבית</button>
      ${i.landlord ? landlordMsgBtn(i) : ''}
      <button class="btn danger block" style="margin-top:8px" data-a="issue-del" data-id="${i.id}">מחיקה</button>
    `);
  }
  function landlordMsgBtn(i) {
    const ll = D().info.find((x) => /בעל הבית|בעלת הבית/.test(x.label) && x.value);
    const phone = ll && (ll.value.match(/[+\d][\d\-\s]{7,}/) || [])[0];
    if (!phone) return '<p class="small muted">כדי לשלוח הודעה לבעל הבית בלחיצה, הוסיפו את המספר שלו ב"עוד" ואז "פרטי הדירה".</p>';
    let p = phone.replace(/\D/g, '');
    if (p.startsWith('0')) p = '972' + p.slice(1);
    const msg = `היי, יש תקלה בדירה: ${i.title}${i.description ? '\n' + i.description : ''}`;
    return `<a class="btn block" style="text-decoration:none;margin-bottom:8px" href="https://wa.me/${p}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">💬 שליחה לבעל הבית בוואטסאפ</a>`;
  }

  // ---------- more ----------
  function viewMore() {
    const sub = S.sub.more;
    const seg = `<div class="seg">
      ${[['polls', 'סקרים'], ['info', 'פרטי הדירה'], ['members', 'שותפים'], ['settings', 'הגדרות']].map(([k, l]) => `<button class="${sub === k ? 'on' : ''}" data-a="sub" data-k="more" data-v="${k}">${l}</button>`).join('')}
    </div>`;
    if (sub === 'polls') return seg + viewPolls();
    if (sub === 'info') return seg + viewInfo();
    if (sub === 'members') return seg + viewMembers();
    return seg + viewSettings();
  }
  function pollCard(p) {
    const total = p.votes.length;
    const myVote = p.votes.find((v) => v.member_id === me().id);
    return `<div class="card">
      <div class="row between"><b class="grow">${esc(p.question)}</b>${p.closed ? '<span class="tag">סגור</span>' : ''}<button class="icon-btn" data-a="poll-menu" data-id="${p.id}">⋯</button></div>
      <div class="small muted">${esc(M(p.created_by).name)} · ${rel(p.created_at)} · ${total}/${D().members.length} הצביעו</div>
      ${p.options.map((o) => {
        const vs = p.votes.filter((v) => v.option_id === o.id);
        const pct = total ? Math.round((vs.length / total) * 100) : 0;
        return `<button class="opt ${myVote && myVote.option_id === o.id ? 'mine' : ''}" ${p.closed ? 'disabled' : `data-a="poll-vote" data-id="${p.id}" data-o="${o.id}"`}>
          <span class="fill" style="width:${myVote || p.closed ? pct : 0}%"></span>
          <span class="row between"><span>${myVote && myVote.option_id === o.id ? '✓ ' : ''}${esc(o.text)}</span>
          <span class="row" style="gap:3px">${myVote || p.closed ? vs.map((v) => av(v.member_id, 'sm')).join('') + `<span class="small muted">&nbsp;${pct}%</span>` : ''}</span></span>
        </button>`;
      }).join('')}
    </div>`;
  }
  function viewPolls() {
    const d = D();
    return `<button class="btn primary block" style="margin-bottom:12px" data-a="poll-new">+ סקר חדש</button>
      ${d.polls.length ? d.polls.map(pollCard).join('') : '<div class="card empty"><span class="big">🗳️</span>אין סקרים. "קונים שואב חדש?"</div>'}`;
  }
  function viewInfo() {
    const d = D();
    return `<div class="card">${d.info.length ? d.info.map((i) => `<div class="info-row">
        <div class="grow" data-a="info-edit" data-id="${i.id}" style="cursor:pointer"><div class="lbl">${esc(i.label)}</div><div class="val">${i.value ? (phoneLike(i.value) ? `<a href="tel:${esc(i.value.replace(/[^\d+]/g, ''))}">${esc(i.value)}</a>` : esc(i.value)) : '<span class="muted small">לחצו להוספה</span>'}</div></div>
        ${i.value ? `<button class="icon-btn" data-a="copy" data-v="${esc(i.value)}" aria-label="העתקה">⧉</button>` : ''}
      </div>`).join('') : '<div class="empty">אין פרטים</div>'}</div>
      <button class="btn primary block" data-a="info-new">+ פרט חדש</button>`;
  }
  function viewMembers() {
    const d = D();
    const link = `${location.origin}/?join=${d.apartment.code}`;
    return `<div class="card" style="text-align:center">
        <div class="small muted">קוד הזמנה לדירה</div>
        <div class="code" style="margin:6px 0 10px">${esc(d.apartment.code)}</div>
        <div class="row"><button class="btn primary grow" data-a="share-invite">📤 שליחת הזמנה</button><button class="btn" data-a="copy" data-v="${esc(link)}">העתקת קישור</button></div>
      </div>
      <div class="section-title">סדר הסבב</div>
      <div class="card">${d.members.map((m, idx) => `<div class="row" style="padding:8px 0">
        <span class="muted small" style="width:16px">${idx + 1}</span>${av(m.id)}<div class="grow"><b>${esc(m.name)}</b>${m.id === me().id ? ' <span class="small muted">(אני)</span>' : ''}</div>
        <button class="icon-btn" data-a="mem-move" data-id="${m.id}" data-d="-1" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="icon-btn" data-a="mem-move" data-id="${m.id}" data-d="1" ${idx === d.members.length - 1 ? 'disabled' : ''}>▼</button>
        ${m.id !== me().id ? `<button class="icon-btn" data-a="mem-remove" data-id="${m.id}" aria-label="הסרה">✕</button>` : ''}
      </div>`).join('')}</div>
      <p class="small muted" style="margin:0 4px">שינוי הסדר או הוספה והסרה של שותף מעדכנים את הסבב העתידי.</p>`;
  }
  const COLORS = ['#e76f51', '#2a9d8f', '#8e7dbe', '#e9a23b', '#457b9d', '#d1495b', '#66a182', '#c77dff'];
  function viewSettings() {
    const d = D();
    const loginLink = `${location.origin}/?login=${S.token}`;
    return `<div class="card">
        <div class="field"><label>השם שלי</label><input class="input" id="set-name" value="${esc(me().name)}" maxlength="30"></div>
        <div class="field"><label>הצבע שלי</label><div class="color-pick">${COLORS.map((c) => `<button class="${me().color === c ? 'on' : ''}" style="background:${c}" data-a="set-color" data-v="${c}"></button>`).join('')}</div></div>
        <div class="field"><label>שם הדירה</label><input class="input" id="set-apt" value="${esc(d.apartment.name)}" maxlength="60"></div>
        <button class="btn primary block" data-a="set-save">שמירה</button>
      </div>
      <div class="card">
        <b>כניסה ממכשיר נוסף</b>
        <p class="small muted">זה הקישור האישי שלך. פתיחה שלו בדפדפן אחר מחברת אותך בתור ${esc(me().name)}. אל תשלחו אותו לאחרים.</p>
        <button class="btn block" data-a="copy" data-v="${esc(loginLink)}">העתקת קישור כניסה אישי</button>
      </div>
      <div class="card">
        <b>התקנה כאפליקציה</b>
        <p class="small muted" style="margin-bottom:0">אייפון (Safari): כפתור שיתוף ואז "הוספה למסך הבית".<br>אנדרואיד (Chrome): תפריט ⋮ ואז "התקנת אפליקציה".</p>
      </div>
      <button class="btn block" data-a="logout">התנתקות מהמכשיר הזה</button>
      <button class="btn danger block" style="margin-top:8px" data-a="leave">עזיבת הדירה</button>
      <p class="small muted" style="text-align:center;margin-top:16px">Dira · ${esc(d.apartment.name)}</p>`;
  }

  // ---------- actions ----------
  const A = {
    reload: () => location.reload(),
    tab: (ds) => { S.tab = ds.tab; if (ds.sub) S.sub[ds.tab] = ds.sub; render(); window.scrollTo(0, 0); },
    sub: (ds) => { S.sub[ds.k] = ds.v; render(); },
    'sheet-bg': (ds, el, ev) => { if (ev.target === el) closeSheet(); },
    copy: async (ds) => { try { await navigator.clipboard.writeText(ds.v); toast('הועתק'); } catch { prompt('העתקה:', ds.v); } },
    'view-img': (ds) => viewImage(ds.id),

    // onboarding
    'onb-mode': (ds) => { saveOnb(); S.onb.mode = ds.mode; renderOnboarding(); },
    'onb-go': async () => {
      saveOnb();
      const o = S.onb;
      try {
        const j = o.mode === 'create'
          ? await api('POST', 'apartments', { aptName: o.aptName, memberName: o.memberName })
          : await api('POST', 'join', { code: o.code, memberName: o.memberName });
        S.token = j.token;
        localStorage.setItem(LS, j.token);
        history.replaceState(null, '', '/');
        if (o.mode === 'create') { S.tab = 'more'; S.sub.more = 'members'; }
        await refresh(true);
        if (o.mode === 'create') toast('הדירה נוצרה! שלחו את ההזמנה לשותפים');
      } catch (e) { toast(e.message); }
    },

    // notices
    'toggle-pin-draft': () => { S.draft.pinned = !S.draft.pinned; render(); },
    'notice-add': async () => {
      const text = S.draft.notice.trim();
      if (!text) return toast('כתבו משהו');
      if (await act('POST', 'notices', { text, pinned: S.draft.pinned })) { S.draft.notice = ''; S.draft.pinned = false; render(); }
    },
    'notice-menu': (ds) => {
      const n = D().notices.find((x) => x.id === ds.id);
      openSheet(`<h2>מודעה</h2><p style="white-space:pre-wrap">${esc(n.text)}</p>
        <button class="btn block" data-a="notice-pin" data-id="${n.id}" data-v="${n.pinned ? 0 : 1}">${n.pinned ? 'ביטול נעיצה' : '📌 נעיצה למעלה'}</button>
        <button class="btn danger block" style="margin-top:8px" data-a="notice-del" data-id="${n.id}">מחיקה</button>`);
    },
    'notice-pin': async (ds) => { closeSheet(); await act('PATCH', 'notices/' + ds.id, { pinned: ds.v === '1' }); },
    'notice-del': async (ds) => { closeSheet(); await act('DELETE', 'notices/' + ds.id, null, 'נמחק'); },

    // chores
    'chore-done': (ds) => act('POST', `chores/${ds.id}/done`, { period: +ds.period }, 'כל הכבוד! ✨'),
    'chore-done-photo': async (ds) => {
      const image = await pickImage();
      if (!image) return;
      toast('מעלה…');
      await act('POST', `chores/${ds.id}/done`, { period: +ds.period, image }, 'כל הכבוד! ✨');
    },
    'chore-undo': (ds) => act('DELETE', `chores/${ds.id}/done/${ds.period}`),
    'chore-new': () => choreSheet(null),
    'chore-edit': (ds) => choreSheet(D().chores.find((c) => c.id === ds.id)),
    'pick-icon': (ds, el) => { sheetCtx.icon = ds.v; el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); },
    'chore-save': async (ds) => {
      const body = { name: val('c-name'), icon: sheetCtx.icon, freq_days: +val('c-freq'), weight: +val('c-weight') };
      if (!body.name) return toast('צריך שם');
      closeSheet();
      await act(ds.id ? 'PATCH' : 'POST', ds.id ? 'chores/' + ds.id : 'chores', body, 'נשמר');
    },
    'chore-del': async (ds) => { if (!confirm('למחוק את המטלה?')) return; closeSheet(); await act('DELETE', 'chores/' + ds.id, null, 'נמחק'); },
    'swap-ask': (ds) => {
      const others = D().members.filter((m) => m.id !== me().id);
      if (!others.length) return toast('אין עם מי להחליף עדיין');
      openSheet(`<h2>עם מי להחליף?</h2><p class="small muted">השותף/ה ייקח/תיקח את התור שלך עכשיו, ואת/ה תיקח/י את התור הבא שלו/ה במטלה הזו.</p>
        ${others.map((m) => `<button class="btn block" style="justify-content:flex-start;margin-bottom:8px" data-a="swap-send" data-id="${ds.id}" data-period="${ds.period}" data-to="${m.id}">${av(m.id)} ${esc(m.name)}</button>`).join('')}`);
    },
    'swap-send': async (ds) => { closeSheet(); await act('POST', 'swaps', { chore_id: ds.id, period: +ds.period, to_member: ds.to }, 'הבקשה נשלחה'); },
    'swap-accept': (ds) => act('POST', `swaps/${ds.id}/accept`, null, 'הוחלף ✓'),
    'swap-reject': (ds) => act('POST', `swaps/${ds.id}/reject`),
    assign: (ds) => {
      const c = D().chores.find((x) => x.id === ds.id);
      openSheet(`<h2>${esc(c.icon || '')} ${esc(c.name)}</h2><p class="small muted">שיבוץ ידני לתור הזה</p>
        ${D().members.map((m) => `<button class="btn block" style="justify-content:flex-start;margin-bottom:8px" data-a="assign-set" data-id="${ds.id}" data-period="${ds.period}" data-m="${m.id}">${av(m.id)} ${esc(m.name)}</button>`).join('')}`);
    },
    'assign-set': async (ds) => { closeSheet(); await act('POST', `chores/${ds.id}/assign`, { period: +ds.period, member_id: ds.m }, 'שובץ'); },

    // shopping
    'draft-kind': (ds) => { S.draft.kind = ds.v; render(); },
    'draft-urgent': () => { S.draft.urgent = !S.draft.urgent; render(); },
    'draft-opts': () => { S.draft.opts = !S.draft.opts; render(); },
    'shop-add': async () => {
      const dr = S.draft;
      if (!dr.name.trim()) { document.getElementById('s-name')?.focus(); return; }
      const body = { name: dr.name, qty: dr.qty, note: dr.note, kind: dr.kind, urgent: dr.urgent };
      dr.name = ''; dr.qty = ''; dr.note = ''; dr.urgent = false; dr.opts = false;
      await act('POST', 'shopping', body);
      document.getElementById('s-name')?.focus();
    },
    'shop-quick': (ds) => act('POST', 'shopping', { name: ds.v, kind: 'shared' }, `נוסף: ${ds.v}`),
    'shop-filter': (ds) => { S.shopFilter = ds.v; render(); },
    'shop-toggle': (ds) => act('PATCH', 'shopping/' + ds.id, { bought: ds.b === '1' }),
    'shop-clear': () => act('POST', 'shopping/clear'),
    'shop-edit': (ds) => shopSheet(D().shopping.find((s) => s.id === ds.id)),
    'e-kind': (ds, el) => { sheetCtx.kind = ds.v; el.parentElement.querySelectorAll('[data-a="e-kind"]').forEach((b) => b.classList.toggle('on', b === el)); },
    'e-urgent': (ds, el) => { sheetCtx.urgent = !sheetCtx.urgent; el.classList.toggle('on', sheetCtx.urgent); },
    'shop-save': async (ds) => {
      const body = { name: val('e-name'), qty: val('e-qty'), note: val('e-note'), kind: sheetCtx.kind, urgent: sheetCtx.urgent };
      closeSheet();
      await act('PATCH', 'shopping/' + ds.id, body, 'נשמר');
    },
    'shop-del': async (ds) => { closeSheet(); await act('DELETE', 'shopping/' + ds.id, null, 'נמחק'); },
    'store-toggle': (ds) => act('POST', 'store', { on: ds.on === '1' }, ds.on === '1' ? 'כולם רואים שאת/ה בסופר' : 'סיימת קניות'),

    // inventory
    'inv-set': (ds) => act('PATCH', 'inventory/' + ds.id, { status: ds.v }, ds.v === 'ok' ? null : 'נוסף לרשימת הקניות'),
    'inv-edit': () => { S.invEdit = !S.invEdit; render(); },
    'inv-del': async (ds) => { if (confirm('להסיר מהמלאי?')) await act('DELETE', 'inventory/' + ds.id); },
    'inv-new': () => {
      sheetCtx = {};
      openSheet(`<h2>מוצר למלאי</h2>
        <div class="field"><label>שם</label><input class="input" id="inv-name" placeholder="למשל: קפה" maxlength="60" autofocus></div>
        <div class="field"><label>אייקון</label><div class="emoji-pick">${INV_ICONS.map((e, i) => `<button class="${i === INV_ICONS.length - 1 ? 'on' : ''}" data-a="pick-icon" data-v="${e}">${e}</button>`).join('')}</div></div>
        <button class="btn primary block" data-a="inv-save">הוספה</button>`, { icon: '📦' });
    },
    'inv-save': async () => {
      const name = val('inv-name');
      if (!name) return toast('צריך שם');
      const icon = sheetCtx.icon;
      closeSheet();
      await act('POST', 'inventory', { name, icon }, 'נוסף');
    },

    // issues
    'issue-new': () => issueNewSheet(),
    'i-landlord': (ds, el) => { sheetCtx.landlord = !sheetCtx.landlord; el.classList.toggle('on', sheetCtx.landlord); },
    'i-photo': async (ds, el) => {
      const img = await pickImage();
      if (!img) return;
      sheetCtx.image = img;
      el.classList.add('on');
      document.getElementById('i-prev').innerHTML = `<img class="photo-prev" src="${img}" alt="">`;
    },
    'issue-save': async () => {
      const title = val('i-title');
      if (!title) return toast('מה קרה?');
      const body = { title, description: val('i-desc'), landlord: sheetCtx.landlord, image: sheetCtx.image };
      closeSheet();
      toast('שומר…');
      await act('POST', 'issues', body, 'התקלה נפתחה');
    },
    'issue-open': (ds) => issueSheet(D().issues.find((i) => i.id === ds.id)),
    'issue-set': async (ds) => {
      const body = { [ds.f]: ds.f === 'landlord' ? ds.v === '1' : ds.v };
      await act('PATCH', 'issues/' + ds.id, body);
      const i = D().issues.find((x) => x.id === ds.id);
      if (i && $sheet.innerHTML) issueSheet(i); else closeSheet();
    },
    'issue-del': async (ds) => { if (!confirm('למחוק את התקלה?')) return; closeSheet(); await act('DELETE', 'issues/' + ds.id, null, 'נמחק'); },

    // polls
    'poll-new': () => {
      openSheet(`<h2>סקר חדש</h2>
        <div class="field"><label>שאלה</label><input class="input" id="p-q" placeholder="למשל: מזמינים מנקה פעם בחודש?" maxlength="200" autofocus></div>
        <div class="field"><label>אפשרויות</label><div id="p-opts">
          <input class="input" style="margin-bottom:6px" placeholder="אפשרות 1" value="כן" maxlength="80">
          <input class="input" style="margin-bottom:6px" placeholder="אפשרות 2" value="לא" maxlength="80">
        </div><button class="btn sm" data-a="poll-add-opt">+ אפשרות</button></div>
        <button class="btn primary block" data-a="poll-save">פרסום</button>`);
    },
    'poll-add-opt': () => {
      const box = document.getElementById('p-opts');
      if (box.children.length >= 8) return;
      const i = document.createElement('input');
      i.className = 'input'; i.style.marginBottom = '6px'; i.maxLength = 80; i.placeholder = `אפשרות ${box.children.length + 1}`;
      box.appendChild(i); i.focus();
    },
    'poll-save': async () => {
      const question = val('p-q');
      const options = [...document.querySelectorAll('#p-opts input')].map((i) => i.value.trim()).filter(Boolean);
      if (!question || options.length < 2) return toast('צריך שאלה ושתי אפשרויות');
      closeSheet();
      await act('POST', 'polls', { question, options }, 'הסקר פורסם');
    },
    'poll-vote': (ds) => act('POST', `polls/${ds.id}/vote`, { option_id: ds.o }),
    'poll-menu': (ds) => {
      const p = D().polls.find((x) => x.id === ds.id);
      openSheet(`<h2>${esc(p.question)}</h2>
        ${!p.closed ? `<button class="btn block" data-a="poll-close" data-id="${p.id}">סגירת הסקר</button>` : ''}
        <button class="btn danger block" style="margin-top:8px" data-a="poll-del" data-id="${p.id}">מחיקה</button>`);
    },
    'poll-close': async (ds) => { closeSheet(); await act('POST', `polls/${ds.id}/close`); },
    'poll-del': async (ds) => { closeSheet(); await act('DELETE', 'polls/' + ds.id, null, 'נמחק'); },

    // info
    'info-new': () => infoSheet(null),
    'info-edit': (ds) => infoSheet(D().info.find((i) => i.id === ds.id)),
    'info-save': async (ds) => {
      const body = { label: val('f-label'), value: val('f-value') };
      if (!body.label) return toast('צריך כותרת');
      closeSheet();
      await act(ds.id ? 'PATCH' : 'POST', ds.id ? 'info/' + ds.id : 'info', body, 'נשמר');
    },
    'info-del': async (ds) => { closeSheet(); await act('DELETE', 'info/' + ds.id, null, 'נמחק'); },

    // members & settings
    'share-invite': async () => {
      const d = D();
      const url = `${location.origin}/?join=${d.apartment.code}`;
      const text = `הצטרפו לדירה "${d.apartment.name}" ב-Dira: תורנויות, קניות ותקלות. קוד: ${d.apartment.code}`;
      if (navigator.share) { try { await navigator.share({ title: 'Dira', text, url }); } catch {} }
      else { try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('ההזמנה הועתקה'); } catch { prompt('העתקה:', url); } }
    },
    'mem-move': async (ds) => {
      const ids = D().members.map((m) => m.id);
      const i = ids.indexOf(ds.id), j = i + +ds.d;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await act('POST', 'members/order', { ids });
    },
    'mem-remove': async (ds) => { if (!confirm(`להסיר את ${M(ds.id).name} מהדירה?`)) return; await act('DELETE', 'members/' + ds.id, null, 'הוסר/ה'); },
    'set-color': (ds, el) => { sheetCtx.color = ds.v; el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el)); S.pickColor = ds.v; },
    'set-save': async () => {
      const ok1 = await act('PATCH', 'me', { name: val('set-name'), color: S.pickColor || me().color });
      const apt = val('set-apt');
      if (ok1 && apt && apt !== D().apartment.name) await act('PATCH', 'apartment', { name: apt });
      if (ok1) toast('נשמר');
    },
    logout: () => { if (confirm('להתנתק? אפשר לחזור עם קישור הכניסה האישי, או להצטרף מחדש עם קוד.')) logout(); },
    leave: async () => {
      if (!confirm('לעזוב את הדירה? תוסר/י מהסבב ומהרשימות.')) return;
      try { await api('DELETE', 'members/' + me().id); } catch {}
      logout();
    },
  };
  function infoSheet(i) {
    openSheet(`<h2>${i ? 'עריכה' : 'פרט חדש'}</h2>
      <div class="field"><label>כותרת</label><input class="input" id="f-label" value="${esc(i ? i.label : '')}" placeholder="למשל: קוד לבניין" maxlength="60"></div>
      <div class="field"><label>ערך</label><textarea class="input" id="f-value" maxlength="500" rows="2" ${i ? 'autofocus' : ''}>${esc(i ? i.value : '')}</textarea></div>
      <button class="btn primary block" data-a="info-save" data-id="${i ? i.id : ''}">שמירה</button>
      ${i ? `<button class="btn danger block" style="margin-top:8px" data-a="info-del" data-id="${i.id}">מחיקה</button>` : ''}`);
  }
  function saveOnb() {
    const g = (id) => { const e = document.getElementById(id); return e ? e.value.trim() : null; };
    const o = S.onb;
    o.aptName = g('o-apt') ?? o.aptName;
    o.code = (g('o-code') ?? o.code).toUpperCase();
    o.memberName = g('o-name') ?? o.memberName;
  }

  // ---------- events ----------
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.a];
    if (fn) { if (el.tagName === 'A') return; fn(el.dataset, el, ev); }
  });
  document.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-a-change]');
    if (el && el.dataset.aChange === 'issue-assignee') {
      act('PATCH', 'issues/' + el.dataset.id, { assignee: el.value }, 'עודכן');
    }
  });
  document.addEventListener('input', (ev) => {
    const b = ev.target.dataset && ev.target.dataset.bind;
    if (b) S.draft[b] = ev.target.value;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.isComposing) return;
    if (ev.target.id === 's-name') { ev.preventDefault(); A['shop-add'](); }
    if (ev.target.id === 'o-name' || ev.target.id === 'o-code' || ev.target.id === 'o-apt') { ev.preventDefault(); A['onb-go'](); }
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const ae = document.activeElement;
      if (S.pendingRender && !$sheet.innerHTML && !(ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName))) { S.pendingRender = false; render(); }
    }, 200);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && S.token && !$sheet.innerHTML) refresh(); }, 10000);

  // ---------- boot ----------
  (async function boot() {
    const q = new URLSearchParams(location.search);
    if (q.get('login')) {
      S.token = q.get('login');
      localStorage.setItem(LS, S.token);
      history.replaceState(null, '', '/');
    }
    if (q.get('join') && !S.token) {
      S.onb.mode = 'join';
      S.onb.code = q.get('join').toUpperCase();
      try { const j = await api('GET', 'invite/' + encodeURIComponent(S.onb.code)); S.onb.invitedTo = j.name; } catch {}
    }
    if (S.token) await refresh(true); else render();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})();
