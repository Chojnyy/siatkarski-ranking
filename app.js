/* Siatkarski Ranking — frontend (bez kroku budowania).
   Cała logika reguł jest w bazie (supabase/schema.sql); tu tylko UI
   i lustrzane sprawdzenia, żeby nie pokazywać przycisków, które i tak by nie przeszły. */
(() => {
'use strict';

const CFG = window.APP_CONFIG || {};
const TZ = 'Europe/Warsaw';
const app = document.getElementById('app');
const tabbar = document.getElementById('tabbar');
const sheet = document.getElementById('sheet');
const sheetBody = document.getElementById('sheetBody');
const toasts = document.getElementById('toasts');

let sb = null;
const S = {
  session: null, me: null, members: [], byId: {},
  config: { entry_window_hours: 24, vote_window_hours: 24, launch_date: '2027-01-01' },
  cur: null, sheetKind: null, booted: false,
};
let sheetResolve = null;
let renderToken = 0;

/* ================= narzędzia ================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const H = 3600e3;
const fmt = (opts) => new Intl.DateTimeFormat('pl-PL', { timeZone: TZ, ...opts });
const fDay = (d) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d));
const fTime = (d) => fmt({ hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const fDT = (d) => `${fDay(d)}, ${fTime(d)}`;
const fDayNum = (d) => fmt({ day: 'numeric' }).format(new Date(d));
const fMon = (d) => fmt({ month: 'short' }).format(new Date(d)).replace('.', '');
const yearOf = (d) => +fmt({ year: 'numeric' }).format(new Date(d));
const launchYear = () => +String(S.config.launch_date).slice(0, 4);
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const name = (uid) => S.byId[uid]?.display_name || 'Ktoś';
const nameMe = (uid) => esc(name(uid)) + (uid === S.me?.id ? ' <span class="muted">(Ty)</span>' : '');
function hue(uid) { let h = 2166136261; for (const c of String(uid)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) * 137) % 360; }
function av(uid, cls = '') {
  const p = S.byId[uid];
  if (p?.avatar_url) return `<span class="av ${cls}"><img src="${esc(p.avatar_url)}" referrerpolicy="no-referrer" alt="" loading="lazy"></span>`;
  const ini = (p?.display_name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="av ${cls}" style="background:hsl(${hue(uid)} 70% 62%)">${esc(ini)}</span>`;
}

const TYPE_LABEL = { ekipowa: 'Ekipowa', mieszana: 'Mieszana', randomy: 'Randomy' };
const typeChip = (t) => `<span class="chip ${t}">${TYPE_LABEL[t]}</span>`;

function times(s) {
  const st = new Date(s.start_at), en = new Date(s.end_at);
  return {
    st, en,
    mid: new Date((st.getTime() + en.getTime()) / 2),
    voteEnd: new Date(en.getTime() + (S.config.vote_window_hours || 24) * H),
    leadEnd: new Date(st.getTime() + (S.config.entry_window_hours || 24) * H),
  };
}
function phase(s) {
  const n = Date.now(), t = times(s);
  if (n < t.st) return { key: 'soon', label: 'Nadchodzi', cls: '' };
  if (n < t.mid) return { key: 'live', label: 'Trwa · wyzwania otwarte', cls: 'live' };
  if (n < t.en) return { key: 'live', label: 'Trwa', cls: 'live' };
  if (n < t.voteEnd) return { key: 'vote', label: 'Głosowanie', cls: 'vote' };
  return { key: 'done', label: 'Zakończona', cls: '' };
}
const phaseChip = (s) => { const p = phase(s); return `<span class="chip ${p.cls}">${p.label}</span>`; };

/* ================= feedback: toasty, animacje ================= */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toasts.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'err' ? 4500 : 2200);
}
let lastPt = { x: innerWidth / 2, y: innerHeight / 2 };
document.addEventListener('pointerdown', (e) => { lastPt = { x: e.clientX, y: e.clientY }; }, true);
function burst(emojis = ['🏐', '✨'], n = 12) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const { x, y } = lastPt;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    p.textContent = emojis[i % emojis.length];
    const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 80;
    p.style.left = `${x - 10}px`; p.style.top = `${y - 12}px`;
    p.style.setProperty('--dx', `${Math.cos(a) * r}px`);
    p.style.setProperty('--dy', `${Math.sin(a) * r - 40}px`);
    p.style.setProperty('--rot', `${Math.random() * 360 - 180}deg`);
    document.body.append(p);
    setTimeout(() => p.remove(), 1000);
  }
}
function floatText(text = '+1') {
  const el = document.createElement('span');
  el.className = 'plus1'; el.textContent = text;
  el.style.left = `${lastPt.x - 14}px`; el.style.top = `${lastPt.y - 20}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1000);
}

/* ================= sheet (panel od dołu) ================= */
function openSheet(html, kind = null) {
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(null); }
  S.sheetKind = kind;
  sheetBody.innerHTML = html;
  sheet.hidden = false;
}
function closeSheet() {
  sheet.hidden = true; sheetBody.innerHTML = ''; S.sheetKind = null;
  if (sheetResolve) { const r = sheetResolve; sheetResolve = null; r(null); }
}
function askReason(title, hint = 'Powód zapisze się w historii.') {
  return new Promise((res) => {
    openSheet(`<h3>${esc(title)}</h3>
      <form data-form="reason">
        <label class="f"><span>Powód</span><textarea class="input" name="reason" required placeholder="np. uzgodnione z ekipą na grupie"></textarea></label>
        <p class="small muted">${esc(hint)}</p>
        <div class="btn-row"><button type="button" class="btn" data-action="close-sheet">Anuluj</button><button class="btn primary">Zapisz</button></div>
      </form>`, 'reason');
    sheetResolve = res;
    setTimeout(() => sheetBody.querySelector('textarea')?.focus(), 60);
  });
}

/* ================= backend ================= */
async function rpc(fn, args, btn) {
  btn?.classList.add('busy');
  try {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw error;
    return { ok: true, data };
  } catch (e) {
    toast(e?.message || String(e), 'err');
    return { ok: false };
  } finally { btn?.classList.remove('busy'); }
}
async function q(promise) { const { data, error } = await promise; if (error) throw error; return data; }

async function loadMembers() {
  const rows = await q(sb.from('profiles').select('*').order('display_name'));
  S.byId = Object.fromEntries(rows.map((p) => [p.id, p]));
  S.members = rows.filter((p) => p.is_member);
  S.pending = rows.filter((p) => !p.is_member);
  if (S.byId[S.me.id]) S.me = S.byId[S.me.id];
}
async function loadConfig() {
  const c = await q(sb.from('app_config').select('*').maybeSingle());
  if (c) S.config = c;
}

/* ================= start ================= */
async function boot() {
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || !window.supabase) { app.innerHTML = setupView(); return; }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  sb.auth.onAuthStateChange((ev, sess) => {
    if (ev === 'SIGNED_OUT') location.replace(location.pathname);
    // setTimeout: nie wołamy Supabase wewnątrz callbacku auth (ryzyko zakleszczenia blokady sesji)
    if (ev === 'SIGNED_IN' && sess && !S.booted) { S.session = sess; setTimeout(afterLogin, 0); }
  });
  const { data } = await sb.auth.getSession();
  if (!data.session) { showLogin(); return; }
  S.session = data.session;
  afterLogin();
}

async function afterLogin() {
  if (S.booted) return;
  S.booted = true;
  if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);
  try {
    const me = await q(sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle());
    if (!me || !me.is_member) { app.innerHTML = noAccessView(S.session.user.email); return; }
    S.me = me;
    await Promise.all([loadMembers(), loadConfig()]);
  } catch (e) { app.innerHTML = errorView(e); return; }
  tabbar.hidden = false;
  addEventListener('hashchange', () => { closeSheet(); render(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(true); });
  setInterval(() => { if (!document.hidden && sheet.hidden) render(true); }, 60e3);
  render();
}

function showLogin() {
  app.innerHTML = `<div class="login view">
    <div class="logo">🏐</div>
    <h1>Siatkarski Ranking</h1>
    <p class="muted">Ranking roczny naszej ekipy.<br>Wejście tylko dla osób z ekipy.</p>
    <button class="gbtn" data-action="login">
      <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Zaloguj przez Google
    </button>
  </div>`;
}

function setupView() {
  return `<div class="view"><h1>Konfiguracja</h1>
    <div class="notice">Uzupełnij <b>config.js</b> adresem i kluczem anon z Supabase, a potem odśwież stronę. Instrukcja krok po kroku jest w <b>README.md</b>.</div></div>`;
}
function noAccessView(email) {
  return `<div class="login view"><div class="logo">🔒</div><h1>Brak dostępu</h1>
    <p class="muted">Konto <b>${esc(email)}</b> nie jest jeszcze w ekipie.<br>Poproś administratora o dodanie tego adresu.</p>
    <button class="btn" data-action="logout">Wyloguj</button></div>`;
}
function errorView(e) {
  return `<div class="view"><div class="empty"><span class="big">😵</span>Coś poszło nie tak<br><span class="small">${esc(e?.message || e)}</span><br><br>
    <button class="btn" data-action="reload">Spróbuj ponownie</button></div></div>`;
}

/* ================= router ================= */
const routes = [
  [/^#\/ranking(?:\/(\d{4}))?$/, viewRanking, 'ranking'],
  [/^#\/sesje$/, viewSessions, 'sesje'],
  [/^#\/s\/([\w-]+)$/, viewSession, 'sesje'],
  [/^#\/gracz\/([\w-]+)(?:\/(\d{4}))?$/, viewPlayer, 'ranking'],
  [/^#\/pojedynki$/, viewDuels, 'pojedynki'],
  [/^#\/wiecej$/, viewMore, 'wiecej'],
  [/^#\/admin$/, viewAdmin, 'wiecej'],
  [/^#\/historia$/, viewHistory, 'wiecej'],
  [/^#\/zasady$/, viewRules, 'wiecej'],
];
async function render(soft = false) {
  if (!S.me) return;
  const h = location.hash || '#/ranking';
  const route = routes.find(([re]) => re.test(h));
  if (!route) { location.hash = '#/ranking'; return; }
  const [re, fn, tab] = route;
  tabbar.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));
  const token = ++renderToken;
  if (!soft) app.innerHTML = `<div class="splash"><div class="spin" style="font-size:40px">🏐</div></div>`;
  try {
    const html = await fn(...h.match(re).slice(1));
    if (token !== renderToken) return;
    app.innerHTML = `<div class="${soft ? 'static' : 'view'}">${html}</div>`;
    if (!soft) scrollTo(0, 0);
    if (S.sheetKind === 'roster') openRoster(true);
  } catch (e) {
    if (token === renderToken) app.innerHTML = errorView(e);
  }
  updateDuelBadge();
}

/* ================= RANKING ================= */
async function viewRanking(yearStr) {
  const cur = yearOf(new Date());
  const year = +yearStr || cur;
  const rows = await q(sb.from('v_ranking').select('*').eq('year', year));
  const byUser = Object.fromEntries(rows.map((r) => [r.user_id, r]));
  const list = S.members.map((m) => byUser[m.id] || { user_id: m.id, points: 0, sessions_played: 0, no_challenge_count: 0, last_no_challenge: false })
    .sort((a, b) => b.points - a.points || b.sessions_played - a.sessions_played || name(a.user_id).localeCompare(name(b.user_id), 'pl'));
  const pos = (r) => 1 + list.filter((x) => x.points > r.points).length;
  const firstYear = Math.min(launchYear() - 1, cur);
  const years = []; for (let y = firstYear; y <= Math.max(cur, launchYear()); y++) if (y <= cur) years.push(y);
  const mine = list.find((r) => r.user_id === S.me.id);
  const test = year < launchYear();

  return `
    <h1>Ranking ${year}</h1>
    ${years.length > 1 ? `<div class="seg" style="margin-bottom:12px">${years.map((y) => `<button class="${y === year ? 'on' : ''}" onclick="location.hash='#/ranking/${y}'">${y}${y < launchYear() ? ' · test' : ''}</button>`).join('')}</div>` : ''}
    ${test ? `<div class="notice" style="margin-bottom:12px">🧪 Wersja testowa. Właściwy ranking startuje ${fmt({ day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(S.config.launch_date))} — od tej daty liczymy od zera.</div>` : ''}
    ${mine ? `<div class="card hero row" style="margin-bottom:14px">
      ${av(S.me.id, 'lg')}
      <div class="grow"><div class="muted small">Twoje miejsce</div><div style="font-size:28px;font-weight:800">#${pos(mine)} <span class="muted" style="font-size:15px;font-weight:600">z ${list.length}</span></div></div>
      <div class="pts" style="font-size:34px">${mine.points}<small>pkt</small></div></div>` : ''}
    <div class="list">
      ${list.map((r) => {
        const p = pos(r);
        return `<a class="item tap ${p <= 3 && r.points > 0 ? 'p' + p : ''} ${r.user_id === S.me.id ? 'me' : ''}" href="#/gracz/${r.user_id}/${year}">
          <div class="rank-pos">${p <= 3 && r.points > 0 ? ['🥇', '🥈', '🥉'][p - 1] : p}</div>
          ${av(r.user_id)}
          <div class="grow"><div class="ellipsis" style="font-weight:700">${esc(name(r.user_id))}</div>
            <div class="tiny muted">${r.sessions_played} ${plural(r.sessions_played, 'sesja', 'sesje', 'sesji')}${r.no_challenge_count ? ` · 🕊️ nie wyzywa ×${r.no_challenge_count}` : ''}</div></div>
          ${r.last_no_challenge ? '<span class="chip" title="W ostatniej sesji: nie chcę wyzywać">🕊️</span>' : ''}
          <div class="pts">${r.points}<small>pkt</small></div>
        </a>`;
      }).join('')}
    </div>
    <p class="tiny muted center mt">Max 1 punkt na osobę na sesję. Ranking liczony na żywo z zapisanych głosów i wyników.</p>`;
}
function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
}

/* ================= GRACZ ================= */
async function viewPlayer(uid, yearStr) {
  const year = +yearStr || yearOf(new Date());
  const [parts, pts] = await Promise.all([
    q(sb.from('participants').select('*, sessions(*)').eq('user_id', uid)),
    q(sb.from('v_session_points').select('*').eq('user_id', uid)),
  ]);
  const ptsBy = Object.fromEntries(pts.map((p) => [p.session_id, p]));
  const rows = parts.filter((p) => p.sessions && yearOf(p.sessions.start_at) === year && new Date(p.sessions.start_at) <= new Date())
    .sort((a, b) => new Date(b.sessions.start_at) - new Date(a.sessions.start_at));
  const total = rows.reduce((s, r) => s + (ptsBy[r.session_id]?.points || 0), 0);
  const nc = rows.filter((r) => r.no_challenge).length;
  return `
    <div class="topbar"><a class="back" href="#/ranking/${year}">‹</a><div class="grow muted small">Gracz · ${year}</div></div>
    <div class="card hero" style="text-align:center;padding:20px">
      <div style="display:flex;justify-content:center">${av(uid, 'lg')}</div>
      <div style="font-size:22px;font-weight:800;margin-top:8px">${esc(name(uid))}</div>
      <div class="row" style="justify-content:center;gap:24px;margin-top:12px">
        <div><div class="pts" style="text-align:center">${total}</div><div class="tiny muted">punktów</div></div>
        <div><div class="pts" style="text-align:center">${rows.length}</div><div class="tiny muted">sesji</div></div>
        <div><div class="pts" style="text-align:center">${nc}</div><div class="tiny muted">🕊️ nie wyzywa</div></div>
      </div>
    </div>
    <h2>Historia sesji</h2>
    ${rows.length ? `<div class="list">${rows.map((r) => {
      const p = ptsBy[r.session_id];
      return `<a class="item tap" href="#/s/${r.session_id}">
        <div class="grow"><div style="font-weight:600">${fDay(r.sessions.start_at)} · ${fTime(r.sessions.start_at)}</div>
          <div class="chips" style="margin-top:4px">${typeChip(r.sessions.type)}${r.no_challenge ? '<span class="chip">🕊️ nie wyzywa</span>' : ''}${(p?.reasons || []).map((x) => `<span class="chip good">${esc(x)}</span>`).join('')}</div></div>
        <div class="pts">${p ? '+1' : '0'}</div></a>`;
    }).join('')}</div>` : '<div class="empty"><span class="big">🏖️</span>Brak sesji w tym roku</div>'}`;
}

/* ================= SESJE ================= */
async function viewSessions() {
  const [sessions, mine] = await Promise.all([
    q(sb.from('sessions').select('*, participants(count)').order('start_at', { ascending: false }).limit(150)),
    q(sb.from('participants').select('session_id').eq('user_id', S.me.id)),
  ]);
  const my = new Set(mine.map((m) => m.session_id));
  const active = sessions.filter((s) => phase(s).key !== 'done').sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const past = sessions.filter((s) => phase(s).key === 'done');
  const card = (s) => {
    const n = s.participants?.[0]?.count ?? 0;
    return `<a class="card tap row" href="#/s/${s.id}" style="animation:rise .35s both">
      <div style="text-align:center;min-width:44px"><div style="font-size:22px;font-weight:800;line-height:1">${fDayNum(s.start_at)}</div><div class="tiny muted" style="text-transform:uppercase">${fMon(s.start_at)}</div></div>
      <div class="grow">
        <div style="font-weight:700">${fmt({ weekday: 'long' }).format(new Date(s.start_at))} · ${fTime(s.start_at)}–${fTime(s.end_at)}</div>
        <div class="chips" style="margin-top:6px">${typeChip(s.type)}${phaseChip(s)}${my.has(s.id) ? '<span class="chip good">Grasz</span>' : ''}</div>
        <div class="tiny muted" style="margin-top:6px">Lider: ${esc(name(s.leader_id))} · ${n} ${plural(n, 'osoba', 'osoby', 'osób')}</div>
      </div><div class="muted">›</div></a>`;
  };
  return `
    <h1>Sesje</h1>
    ${active.length ? `<h2>Teraz i wkrótce <span class="count">${active.length}</span></h2>${active.map(card).join('')}` : ''}
    <h2>Zakończone</h2>
    ${past.length ? past.map(card).join('') : '<div class="empty"><span class="big">📅</span>Jeszcze nic tu nie ma.<br>Dodaj pierwszą sesję.</div>'}
    <button class="btn primary fab" data-action="new-session">＋ Sesja</button>`;
}

function sessionForm(s) {
  const now = new Date();
  const st = s ? new Date(s.start_at) : null, en = s ? new Date(s.end_at) : null;
  const type = s?.type || 'ekipowa';
  const isRand = type === 'randomy';
  const mvp = s ? s.mvp_enabled : !!S.config.randomy_mvp_default;
  const duels = s ? s.duels_enabled : !!S.config.randomy_duels_default;
  return `<h3>${s ? 'Edytuj sesję' : 'Nowa sesja'}</h3>
    <form data-form="session" data-id="${s?.id || ''}">
      <label class="f"><span>Data</span><input class="input" type="date" name="date" required value="${st ? localDate(st) : localDate(now)}"></label>
      <div class="grid2">
        <label class="f"><span>Start</span><input class="input" type="time" name="start" required value="${st ? localTime(st) : '20:00'}"></label>
        <label class="f"><span>Koniec</span><input class="input" type="time" name="end" required value="${en ? localTime(en) : '22:00'}"></label>
      </div>
      <label class="f"><span>Typ sesji</span>
        <input type="hidden" name="type" value="${type}">
        <div class="seg">${['ekipowa', 'mieszana', 'randomy'].map((t) => `<button type="button" class="${t === type ? 'on' : ''}" data-action="seg" data-name="type" data-value="${t}">${TYPE_LABEL[t]}</button>`).join('')}</div>
      </label>
      <p class="small muted" id="typeHint">${typeHint(type)}</p>
      <div id="randOpts" ${isRand ? '' : 'hidden'} class="card" style="margin-bottom:12px">
        <div class="row"><div class="grow">MVP w tej sesji</div><input type="hidden" name="mvp" value="${mvp}"><span class="toggle ${mvp ? 'on' : ''}" data-action="form-toggle" data-name="mvp"></span></div>
        <div class="row mt"><div class="grow">Pojedynki w tej sesji</div><input type="hidden" name="duels" value="${duels}"><span class="toggle ${duels ? 'on' : ''}" data-action="form-toggle" data-name="duels"></span></div>
      </div>
      <label class="f"><span>Lider</span><select class="input" name="leader">${S.members.map((m) => `<option value="${m.id}" ${m.id === (s?.leader_id || S.me.id) ? 'selected' : ''}>${esc(m.display_name)}</option>`).join('')}</select></label>
      <label class="f"><span>Notatka (opcjonalnie)</span><input class="input" name="note" maxlength="140" value="${esc(s?.note || '')}" placeholder="np. hala przy szkole"></label>
      <button class="btn primary block">${s ? 'Zapisz zmiany' : 'Utwórz sesję'}</button>
      ${s && S.me.is_admin ? `<button type="button" class="btn bad block mt" data-action="delete-session" data-id="${s.id}">Usuń sesję</button>` : ''}
    </form>`;
}
function typeHint(t) {
  return {
    ekipowa: 'Wygrana drużyny, MVP i pojedynki dają punkty.',
    mieszana: 'Wygrana drużyny nie daje punktów. MVP i pojedynki dają.',
    randomy: 'Wygrana drużyny nie daje punktów. MVP i pojedynki domyślnie wyłączone.',
  }[t];
}

/* ================= SESJA (szczegóły) ================= */
async function viewSession(id) {
  const s = await q(sb.from('sessions').select('*').eq('id', id).maybeSingle());
  if (!s) return `<div class="topbar"><a class="back" href="#/sesje">‹</a></div><div class="empty"><span class="big">🤷</span>Nie ma takiej sesji</div>`;
  const [parts, duels, mvp, odd, pts, hist, next] = await Promise.all([
    q(sb.from('participants').select('*').eq('session_id', id)),
    q(sb.from('duels').select('*, duel_votes(*)').eq('session_id', id).order('created_at')),
    q(sb.from('mvp_votes').select('*').eq('session_id', id)),
    q(sb.from('odd_awards').select('*').eq('session_id', id)),
    q(sb.from('v_session_points').select('*').eq('session_id', id)),
    q(sb.from('history').select('*').eq('session_id', id).order('at', { ascending: false }).limit(80)),
    q(sb.from('sessions').select('start_at').gt('start_at', s.start_at).order('start_at').limit(1)),
  ]);

  const T = times(s), now = Date.now(), me = S.me.id;
  const isLeader = s.leader_id === me, isAdmin = !!S.me.is_admin;
  const leadOpen = now <= T.leadEnd;
  const nextStart = next[0] ? new Date(next[0].start_at) : null;
  const selfOpen = leadOpen || (!s.leader_submitted_at && (!nextStart || now < nextStart));
  const canEdit = (uid) => (isLeader && leadOpen) || (uid === me && selfOpen);
  const pSet = new Set(parts.map((p) => p.user_id));
  const myPart = parts.find((p) => p.user_id === me);
  const accepted = duels.filter((d) => d.status === 'accepted');
  const inDuel = (uid) => accepted.some((d) => d.challenger_id === uid || d.challenged_id === uid);
  const voteOpen = now >= T.en && now <= T.voteEnd;
  const prevReason = S.cur?.s.id === id ? S.cur.corrReason : null;
  S.cur = { s, parts, duels, mvp, odd, pts, T, isLeader, isAdmin, leadOpen, selfOpen, canEdit, pSet, myPart, inDuel, voteOpen, corrReason: prevReason };

  parts.sort((a, b) => (b.user_id === s.leader_id) - (a.user_id === s.leader_id) || name(a.user_id).localeCompare(name(b.user_id), 'pl'));
  const canManage = (isLeader && leadOpen) || isAdmin;
  const canEditSession = (isLeader && leadOpen) || isAdmin;

  // ----- nagłówek
  let html = `
    <div class="topbar"><a class="back" href="#/sesje">‹</a>
      <div class="grow"><div class="small muted">${fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(T.st)}</div>
      <div style="font-weight:800;font-size:22px">${fTime(T.st)}–${fTime(T.en)}</div></div>
      ${canEditSession ? `<button class="btn sm" data-action="edit-session">✏️ Edytuj</button>` : ''}
    </div>
    <div class="card hero mt">
      <div class="chips">${typeChip(s.type)}${phaseChip(s)}${s.leader_submitted_at ? '<span class="chip good">✓ Wyniki zatwierdzone</span>' : ''}</div>
      <div class="row mt">${av(s.leader_id, 'sm')}<div class="small"><span class="muted">Lider:</span> <b>${nameMe(s.leader_id)}</b></div></div>
      ${s.note ? `<div class="small mt">📍 ${esc(s.note)}</div>` : ''}
      <div class="timeline">
        ${s.duels_enabled ? `<span class="k">Wyzwania / akceptacja do</span><span class="${now > T.mid ? 'past' : ''}">${fTime(T.mid)}</span>
        <span class="k">Wycofanie pojedynku do</span><span class="${now > T.en ? 'past' : ''}">${fTime(T.en)}</span>` : ''}
        ${s.mvp_enabled || s.duels_enabled ? `<span class="k">Głosowanie do</span><span class="${now > T.voteEnd ? 'past' : ''}">${fDT(T.voteEnd)}</span>` : ''}
        <span class="k">Wpis wyników do</span><span class="${now > T.leadEnd ? 'past' : ''}">${fDT(T.leadEnd)}</span>
        ${!leadOpen && !s.leader_submitted_at ? `<span class="k">Wpis własnych wyników</span><span class="${selfOpen ? '' : 'past'}">${nextStart ? `do ${fDT(nextStart)}` : 'do startu następnej sesji'}</span>` : ''}
      </div>
    </div>`;

  // ----- przypomnienia
  if (voteOpen && myPart) {
    const todo = [];
    if (s.mvp_enabled && !mvp.some((v) => v.voter_id === me)) todo.push('MVP');
    const dTodo = accepted.filter((d) => d.challenger_id !== me && d.challenged_id !== me && !d.duel_votes.some((v) => v.voter_id === me));
    if (s.duels_enabled && dTodo.length) todo.push(`${dTodo.length} ${plural(dTodo.length, 'pojedynek', 'pojedynki', 'pojedynków')}`);
    if (todo.length) html += `<div class="notice mt">🗳️ Czeka na Twój głos: <b>${todo.join(' i ')}</b>. Głosowanie trwa do ${fDT(T.voteEnd)}.</div>`;
  }

  // ----- punkty
  if (pts.length) {
    html += `<h2>Punkty z tej sesji ${voteOpen ? '<span class="chip vote">na żywo</span>' : ''}</h2><div class="list">
      ${pts.sort((a, b) => name(a.user_id).localeCompare(name(b.user_id), 'pl')).map((p) => `<div class="item">${av(p.user_id, 'sm')}<div class="grow"><b>${nameMe(p.user_id)}</b>
        <div class="chips" style="margin-top:4px">${p.reasons.map((r) => `<span class="chip good">${esc(r)}</span>`).join('')}</div></div><span class="chip pt">+1</span></div>`).join('')}
    </div>${pts.some((p) => p.reasons.length > 1) ? '<p class="tiny muted">Kilka powodów w jednej sesji = nadal 1 punkt.</p>' : ''}`;
  }

  // ----- skład
  html += `<h2>Skład <span class="count">${parts.length}</span></h2>`;
  if (!myPart && (canEdit(me) || isAdmin)) {
    html += `<button class="btn primary block" data-action="join" style="margin-bottom:10px">🏐 Gram w tej sesji</button>`;
  }
  if (myPart && s.duels_enabled) {
    const ncLocked = !canEdit(me) && !isAdmin;
    html += `<div class="card row" style="margin-bottom:10px"><div class="grow"><b>🕊️ Nie chcę wyzywać</b><div class="tiny muted">Widoczne w rankingu. Bez pary = bez punktu za nieparzystość.</div></div>
      <span class="toggle ${myPart.no_challenge ? 'on' : ''} ${ncLocked ? '' : ''}" ${ncLocked ? 'style="opacity:.4;pointer-events:none"' : ''} data-action="toggle-nc"></span></div>`;
  }
  if (canManage || (isLeader && leadOpen && !s.leader_submitted_at)) {
    html += `<div class="btn-row" style="margin-bottom:10px">
      ${canManage ? `<button class="btn" data-action="roster">👥 Zarządzaj składem${!(isLeader && leadOpen) ? ' (korekta)' : ''}</button>` : ''}
      ${isLeader && leadOpen && !s.leader_submitted_at ? `<button class="btn good" data-action="submit-results">✓ Zatwierdź wyniki</button>` : ''}
    </div>`;
  }
  html += parts.length ? `<div class="list">${parts.map((p) => {
    const editable = canEdit(p.user_id) || isAdmin;
    return `<div class="item">${av(p.user_id)}
      <div class="grow"><div class="ellipsis" style="font-weight:600">${nameMe(p.user_id)}</div>
        <div class="chips" style="margin-top:3px">${p.user_id === s.leader_id ? '<span class="chip">👑 lider</span>' : ''}${p.no_challenge ? '<span class="chip">🕊️ nie wyzywa</span>' : ''}${inDuel(p.user_id) ? '<span class="chip">⚔️ pojedynek</span>' : ''}</div></div>
      ${s.type === 'ekipowa' ? (editable
        ? `<button class="btn sm ${p.team_won ? 'on' : ''}" data-action="toggle-win" data-uid="${p.user_id}">🏆 ${p.team_won ? 'Wygrana' : 'Wygrana?'}</button>`
        : (p.team_won ? '<span class="chip good">🏆 wygrana</span>' : '')) : ''}
      ${p.user_id === me && editable ? `<button class="btn sm ghost" data-action="leave" title="Nie gram">✕</button>` : ''}
    </div>`;
  }).join('')}</div>` : `<div class="empty">Nikt się jeszcze nie zapisał.</div>`;

  // ----- pojedynki
  if (s.duels_enabled) {
    html += `<h2>Pojedynki 1v1 <span class="count">${accepted.length}</span></h2>`;
    const canChallenge = now < T.mid && !myPart?.no_challenge && !inDuel(me);
    if (canChallenge) html += `<button class="btn primary block" data-action="challenge-pick" style="margin-bottom:10px">⚔️ Wyzwij kogoś</button>`;
    else if (now < T.mid && myPart?.no_challenge) html += `<p class="small muted">Masz zaznaczone „nie chcę wyzywać”.</p>`;
    else if (now >= T.mid && now < T.en) html += `<p class="small muted">Wyzwania zamknięte (połowa sesji minęła). Zaakceptowany pojedynek można wycofać do ${fTime(T.en)}.</p>`;
    const visible = duels.filter((d) => d.status !== 'cancelled');
    html += visible.length ? visible.map((d) => duelCard(d, S.cur)).join('<div style="height:8px"></div>') : '<div class="empty small">Brak wyzwań w tej sesji.</div>';

    // nieparzystość
    if (s.type !== 'ekipowa' && now >= T.mid && parts.length) {
      const unpaired = parts.filter((p) => !inDuel(p.user_id));
      if (unpaired.length) {
        const canAward = (isLeader && leadOpen) || isAdmin;
        html += `<h2>Bez pary ${parts.length % 2 ? '<span class="chip">nieparzysta liczba osób</span>' : ''}</h2>
          <p class="small muted">Osoba bez pary, która nie zaznaczyła „nie chcę wyzywać”, może dostać 1 punkt za dobrą grę — przyznaje lider po uzgodnieniu z grupą.</p>
          <div class="list">${unpaired.map((p) => {
            const aw = odd.find((o) => o.user_id === p.user_id);
            return `<div class="item">${av(p.user_id, 'sm')}<div class="grow"><b>${nameMe(p.user_id)}</b>
              ${aw ? `<div class="tiny" style="color:#ffd58a">„${esc(aw.reason)}”</div>` : p.no_challenge ? '<div class="tiny muted">🕊️ nie wyzywa — bez punktu</div>' : ''}</div>
              ${aw ? `<span class="chip pt">+1</span>${canAward ? `<button class="btn sm ghost" data-action="revoke-odd" data-uid="${p.user_id}">Cofnij</button>` : ''}`
                : (!p.no_challenge && canAward ? `<button class="btn sm" data-action="award-odd" data-uid="${p.user_id}">＋1 za grę</button>` : '')}
            </div>`;
          }).join('')}</div>`;
      }
    }
  }

  // ----- MVP
  if (s.mvp_enabled) {
    html += `<h2>MVP sesji</h2>`;
    if (now < T.en) {
      html += `<div class="card small muted">Głosowanie na MVP ruszy po zakończeniu sesji (${fTime(T.en)}) i potrwa do ${fDT(T.voteEnd)}.</div>`;
    } else {
      const valid = mvp.filter((v) => pSet.has(v.voter_id) && pSet.has(v.candidate_id));
      const counts = {}; valid.forEach((v) => { counts[v.candidate_id] = (counts[v.candidate_id] || 0) + 1; });
      const max = Math.max(0, ...Object.values(counts));
      const tops = Object.keys(counts).filter((k) => counts[k] === max);
      const myVote = mvp.find((v) => v.voter_id === me)?.candidate_id;
      const canVote = voteOpen && !!myPart;
      html += `<p class="small muted">${valid.length} / ${parts.length} ${plural(parts.length, 'głos', 'głosy', 'głosów')}${voteOpen ? ` · do ${fDT(T.voteEnd)}` : ' · głosowanie zamknięte'}${canVote ? ' · dotknij, by zagłosować (ponownie — by cofnąć)' : ''}</p>
        <div class="cand-grid">${parts.map((p) => {
          const c = counts[p.user_id] || 0;
          const self = p.user_id === me;
          return `<div class="cand ${myVote === p.user_id ? 'on' : ''} ${c && c === max ? 'lead' : ''}" ${canVote && !self ? `data-action="vote-mvp" data-uid="${p.user_id}"` : 'style="cursor:default;opacity:' + (self && canVote ? '.5' : '1') + '"'}>
            ${av(p.user_id)}<div class="nm ellipsis">${esc(name(p.user_id))}</div><div class="vc">${c} ${c && c === max ? (tops.length === 1 ? '👑' : '🤝') : ''}</div></div>`;
        }).join('')}</div>`;
      if (!voteOpen) {
        html += `<div class="card mt center">${max === 0 ? 'Brak głosów — bez punktu.' : tops.length > 1 ? '🤝 Remis — nikt nie dostaje punktu.' : `👑 MVP: <b>${esc(name(tops[0]))}</b>`}</div>`;
      }
    }
  }

  // ----- historia
  html += `<h2>Historia sesji</h2><details class="card"><summary class="small muted" style="cursor:pointer">Pokaż wpisy (${hist.length})</summary>
    <div class="mt">${hist.map(histLine).join('') || '<div class="small muted">Pusto.</div>'}</div></details>`;
  return html;
}

function duelCard(d, c) {
  const { s, T } = c;
  const now = Date.now(), me = S.me.id;
  const a = d.challenger_id, b = d.challenged_id;
  const mine = me === a || me === b;
  const votes = (d.duel_votes || []).filter((v) => (c.pSet ? c.pSet.has(v.voter_id) : true) && v.voter_id !== a && v.voter_id !== b);
  const va = votes.filter((v) => v.winner_id === a).length, vb = votes.filter((v) => v.winner_id === b).length;
  const myVote = votes.find((v) => v.voter_id === me)?.winner_id;
  let status, actions = '', result = '';
  const expired = d.status === 'pending' && now >= T.mid;

  if (d.status === 'pending') {
    status = expired ? '<span class="chip">⌛ wygasło</span>' : '<span class="chip vote">czeka na akceptację</span>';
    if (!expired && me === b) actions = `<div class="btn-row mt"><button class="btn good" data-action="duel-accept" data-id="${d.id}">✓ Przyjmuję</button><button class="btn bad" data-action="duel-decline" data-id="${d.id}">Odrzucam</button></div><p class="tiny muted center" style="margin:6px 0 0">Akceptacja do ${fTime(T.mid)}</p>`;
    if (!expired && me === a) actions = `<div class="btn-row mt"><button class="btn ghost sm" data-action="duel-withdraw" data-id="${d.id}">Anuluj wyzwanie</button></div>`;
  } else if (d.status === 'declined') status = '<span class="chip">odrzucony</span>';
  else if (d.status === 'withdrawn') status = `<span class="chip">wycofany przez ${esc(name(d.withdrawn_by))}</span>`;
  else if (d.status === 'cancelled') status = '<span class="chip">anulowany</span>';
  else if (d.status === 'accepted') {
    if (now < T.en) {
      status = '<span class="chip live">zaakceptowany</span>';
      if (mine) actions = `<div class="btn-row mt"><button class="btn ghost sm" data-action="duel-withdraw" data-id="${d.id}">Wycofaj pojedynek (do ${fTime(T.en)})</button></div>`;
    } else {
      const open = now <= T.voteEnd;
      status = open ? '<span class="chip vote">głosowanie</span>' : '<span class="chip">rozstrzygnięty</span>';
      const tot = va + vb;
      result = `<div class="bar"><i class="a" style="width:${tot ? (va / tot) * 100 : 50}%;${tot ? '' : 'opacity:.25'}"></i><i class="b" style="width:${tot ? (vb / tot) * 100 : 50}%;${tot ? '' : 'opacity:.25'}"></i></div>`;
      const canVote = open && !mine && c.myPart;
      if (canVote) {
        actions = `<div class="btn-row mt">
          <button class="btn vote-btn ${myVote === a ? 'on' : ''}" data-action="vote-duel" data-id="${d.id}" data-uid="${a}">${esc(name(a))} <span class="n">${va}</span></button>
          <button class="btn vote-btn ${myVote === b ? 'on' : ''}" data-action="vote-duel" data-id="${d.id}" data-uid="${b}">${esc(name(b))} <span class="n">${vb}</span></button></div>`;
      } else {
        actions = `<div class="row small mt" style="justify-content:space-between"><span>${va} ${plural(va, 'głos', 'głosy', 'głosów')}</span><span class="muted">${mine && open ? 'nie głosujesz we własnym pojedynku' : ''}</span><span>${vb} ${plural(vb, 'głos', 'głosy', 'głosów')}</span></div>`;
      }
      if (!open) {
        actions += `<div class="center small mt">${tot === 0 ? 'Brak głosów — bez punktów.' : va === vb ? '🤝 Remis — bez punktów.' : `🏆 Wygrywa <b>${esc(name(va > vb ? a : b))}</b>`}</div>`;
      }
    }
  }
  return `<div class="card duel" style="animation:rise .35s both">
    <div class="row" style="justify-content:center;margin-bottom:10px">${status}</div>
    <div class="vs">
      <div class="side">${av(a)}<div class="name ellipsis">${esc(name(a))}${a === me ? ' (Ty)' : ''}</div><div class="tiny muted">wyzywa</div></div>
      <div class="x">⚔️</div>
      <div class="side">${av(b)}<div class="name ellipsis">${esc(name(b))}${b === me ? ' (Ty)' : ''}</div><div class="tiny muted">wyzwany/a</div></div>
    </div>${result}${actions}</div>`;
}

function openRoster(refresh = false) {
  const c = S.cur; if (!c) return;
  const html = `<h3>Skład sesji${c.corrReason ? ' <span class="chip bad">korekta</span>' : ''}</h3>
    <p class="small muted">Zaznacz, kto grał${c.s.type === 'ekipowa' ? ' i kto wygrał' : ''}. Zmiany zapisują się od razu.</p>
    <div class="list">${S.members.map((m) => {
      const p = c.parts.find((x) => x.user_id === m.id);
      return `<div class="item">${av(m.id, 'sm')}<div class="grow ellipsis"><b>${esc(m.display_name)}</b></div>
        ${c.s.type === 'ekipowa' && p ? `<button class="btn sm ${p.team_won ? 'on' : ''}" data-action="toggle-win" data-uid="${m.id}">🏆</button>` : ''}
        <span class="toggle ${p ? 'on' : ''}" data-action="roster-present" data-uid="${m.id}"></span></div>`;
    }).join('')}</div>
    <button class="btn block mt" data-action="close-sheet">Gotowe</button>`;
  if (refresh) { const top = sheet.querySelector('.sheet').scrollTop; sheetBody.innerHTML = html; sheet.querySelector('.sheet').scrollTop = top; S.sheetKind = 'roster'; sheet.hidden = false; }
  else openSheet(html, 'roster');
}

/* ================= POJEDYNKI (zakładka) ================= */
async function viewDuels() {
  const since = new Date(Date.now() - 45 * 86400e3).toISOString();
  const [duels, myParts] = await Promise.all([
    q(sb.from('duels').select('*, sessions!inner(*), duel_votes(*)').gte('sessions.end_at', since).order('created_at', { ascending: false })),
    q(sb.from('participants').select('session_id').eq('user_id', S.me.id)),
  ]);
  const mySessions = new Set(myParts.map((p) => p.session_id));
  const me = S.me.id, now = Date.now();
  const ctx = (d) => ({ s: d.sessions, T: times(d.sessions), myPart: mySessions.has(d.session_id), pSet: null });
  const incoming = duels.filter((d) => d.status === 'pending' && d.challenged_id === me && now < times(d.sessions).mid);
  const mineActive = duels.filter((d) => (d.challenger_id === me || d.challenged_id === me) && !incoming.includes(d) && (
    (d.status === 'pending' && now < times(d.sessions).mid) || (d.status === 'accepted' && now <= times(d.sessions).voteEnd)));
  const toVote = duels.filter((d) => d.status === 'accepted' && d.challenger_id !== me && d.challenged_id !== me && mySessions.has(d.session_id)
    && now >= times(d.sessions).en && now <= times(d.sessions).voteEnd);
  const sessionLink = (d) => `<a class="tiny muted" href="#/s/${d.session_id}" style="display:block;margin:0 4px 4px">${fDay(d.sessions.start_at)} · ${fTime(d.sessions.start_at)}–${fTime(d.sessions.end_at)} ›</a>`;
  const block = (arr) => arr.map((d) => sessionLink(d) + duelCard(d, ctx(d))).join('<div style="height:12px"></div>');
  const past = duels.filter((d) => (d.challenger_id === me || d.challenged_id === me) && !incoming.includes(d) && !mineActive.includes(d) && d.status !== 'cancelled').slice(0, 15);
  return `<h1>Pojedynki</h1>
    ${incoming.length ? `<h2>Wyzwania do Ciebie <span class="count">${incoming.length}</span></h2>${block(incoming)}` : ''}
    ${toVote.length ? `<h2>Do zagłosowania <span class="count">${toVote.length}</span></h2>${block(toVote)}` : ''}
    ${mineActive.length ? `<h2>Twoje aktywne</h2>${block(mineActive)}` : ''}
    ${!incoming.length && !toVote.length && !mineActive.length ? `<div class="empty"><span class="big">⚔️</span>Nic nie czeka.<br>Wyzwać kogoś możesz z widoku sesji — do połowy jej trwania.</div>` : ''}
    ${past.length ? `<h2>Ostatnie</h2>${block(past)}` : ''}`;
}
async function updateDuelBadge() {
  try {
    const since = new Date(Date.now() - 3 * 86400e3).toISOString();
    const [pend, acc, myParts] = await Promise.all([
      q(sb.from('duels').select('id, sessions!inner(start_at,end_at)').eq('status', 'pending').eq('challenged_id', S.me.id).gte('sessions.end_at', since)),
      q(sb.from('duels').select('id, session_id, challenger_id, challenged_id, sessions!inner(start_at,end_at), duel_votes(voter_id)').eq('status', 'accepted').gte('sessions.end_at', since)),
      q(sb.from('participants').select('session_id').eq('user_id', S.me.id)),
    ]);
    const my = new Set(myParts.map((p) => p.session_id)), now = Date.now(), me = S.me.id;
    const n = pend.filter((d) => now < times(d.sessions).mid).length
      + acc.filter((d) => my.has(d.session_id) && d.challenger_id !== me && d.challenged_id !== me && now >= times(d.sessions).en && now <= times(d.sessions).voteEnd && !d.duel_votes.some((v) => v.voter_id === me)).length;
    document.getElementById('duelBadge').hidden = n === 0;
  } catch { /* nieistotne */ }
}

/* ================= WIĘCEJ / ADMIN / HISTORIA / ZASADY ================= */
async function viewMore() {
  return `<h1>Więcej</h1>
    <div class="card hero row">${av(S.me.id, 'lg')}<div class="grow"><div style="font-weight:800;font-size:18px">${esc(S.me.display_name)}</div><div class="small muted ellipsis">${esc(S.me.email)}</div>
      ${S.me.is_admin ? '<span class="chip vote" style="margin-top:6px">administrator</span>' : ''}</div>
      <button class="btn sm" data-action="rename">✏️</button></div>
    <div class="list mt">
      <a class="item tap" href="#/zasady"><span style="font-size:20px">📜</span><div class="grow"><b>Zasady</b><div class="tiny muted">Jak liczymy punkty</div></div>›</a>
      <a class="item tap" href="#/historia"><span style="font-size:20px">🕓</span><div class="grow"><b>Historia</b><div class="tiny muted">Wszystkie głosy, wyniki i korekty</div></div>›</a>
      ${S.me.is_admin ? `<a class="item tap" href="#/admin"><span style="font-size:20px">🛠️</span><div class="grow"><b>Administracja</b><div class="tiny muted">Ekipa, uprawnienia, ustawienia</div></div>›</a>` : ''}
      <button class="item tap" data-action="logout" style="text-align:left;width:100%;cursor:pointer"><span style="font-size:20px">🚪</span><div class="grow"><b>Wyloguj</b></div></button>
    </div>`;
}

async function viewAdmin() {
  if (!S.me.is_admin) return `<div class="empty">Tylko dla administratora.</div>`;
  await Promise.all([loadMembers(), loadConfig()]);
  const allowed = await q(sb.from('allowed_emails').select('*').order('email'));
  const profileEmails = new Set(Object.values(S.byId).map((p) => p.email));
  const c = S.config;
  return `<div class="topbar"><a class="back" href="#/wiecej">‹</a><h1 style="margin:0">Administracja</h1></div>
    <h2>Ustawienia</h2>
    <div class="card">
      <div class="small muted" style="margin-bottom:8px">Okno wpisu wyników od startu sesji</div>
      <div class="seg">${[24, 48].map((h) => `<button class="${c.entry_window_hours === h ? 'on' : ''}" data-action="cfg-hours" data-value="${h}">${h} h</button>`).join('')}</div>
      <div class="row mt"><div class="grow">MVP w sesjach randomów (domyślnie)</div><span class="toggle ${c.randomy_mvp_default ? 'on' : ''}" data-action="cfg-toggle" data-key="randomy_mvp_default"></span></div>
      <div class="row mt"><div class="grow">Pojedynki w sesjach randomów (domyślnie)</div><span class="toggle ${c.randomy_duels_default ? 'on' : ''}" data-action="cfg-toggle" data-key="randomy_duels_default"></span></div>
    </div>
    <h2>Dodaj do ekipy</h2>
    <form class="card" data-form="add-email">
      <label class="f"><span>Adres Gmail</span><input class="input" type="email" name="email" required placeholder="imie.nazwisko@gmail.com" autocomplete="off"></label>
      <label class="row small" style="margin-bottom:12px"><input type="checkbox" name="admin"> administrator</label>
      <button class="btn primary block">Dodaj</button>
    </form>
    ${S.pending.length ? `<h2>Zalogowani bez dostępu <span class="count">${S.pending.length}</span></h2><div class="list">${S.pending.map((p) => `<div class="item">${av(p.id, 'sm')}<div class="grow"><b>${esc(p.display_name)}</b><div class="tiny muted">${esc(p.email)}</div></div>
      <button class="btn sm good" data-action="approve" data-email="${esc(p.email)}">Wpuść</button></div>`).join('')}</div>` : ''}
    <h2>Ekipa <span class="count">${S.members.length}</span></h2>
    <div class="list">${S.members.map((m) => `<div class="item">${av(m.id, 'sm')}<div class="grow"><b>${nameMe(m.id)}</b><div class="tiny muted ellipsis">${esc(m.email)}</div></div>
      <button class="btn sm ${m.is_admin ? 'on' : ''}" data-action="set-admin" data-uid="${m.id}" ${m.id === S.me.id ? 'disabled' : ''}>🛠️</button>
      ${m.id !== S.me.id ? `<button class="btn sm ghost" data-action="remove-member" data-uid="${m.id}">✕</button>` : ''}</div>`).join('')}</div>
    ${allowed.filter((a) => !profileEmails.has(a.email)).length ? `<h2>Czekają na pierwsze logowanie</h2><div class="list">${allowed.filter((a) => !profileEmails.has(a.email)).map((a) => `<div class="item"><div class="grow small">${esc(a.email)}</div>${a.is_admin ? '<span class="chip">admin</span>' : ''}</div>`).join('')}</div>` : ''}`;
}

async function viewHistory() {
  const rows = await q(sb.from('history').select('*').order('at', { ascending: false }).limit(200));
  return `<div class="topbar"><a class="back" href="#/wiecej">‹</a><h1 style="margin:0">Historia</h1></div>
    <p class="small muted">Każdy głos, wynik, punkt i korekta — z datą, sesją i powodem.</p>
    <div class="card">${rows.map((h) => histLine(h, true)).join('') || '<div class="small muted">Pusto.</div>'}</div>`;
}

const KIND = {
  sesja_utworzona: '📅 Utworzenie sesji', sesja_zmieniona: '✏️ Zmiana sesji', korekta_sesji: '🛠️ Korekta sesji', sesja_usunieta: '🗑️ Usunięcie sesji',
  wyniki_zatwierdzone: '✓ Zatwierdzenie wyników', wynik: '📝 Wynik', korekta: '🛠️ Korekta wyniku',
  wyzwanie: '⚔️ Wyzwanie', pojedynek_przyjety: '🤝 Przyjęcie pojedynku', pojedynek_odrzucony: '🙅 Odrzucenie pojedynku', pojedynek_wycofany: '↩️ Wycofanie pojedynku',
  glos_pojedynek: '🗳️ Głos w pojedynku', glos_pojedynek_wycofany: '↩️ Cofnięcie głosu (pojedynek)', glos_mvp: '👑 Głos na MVP', glos_mvp_wycofany: '↩️ Cofnięcie głosu (MVP)',
  punkt_nieparzystosc: '➕ Punkt za nieparzystość', punkt_nieparzystosc_cofniety: '➖ Cofnięcie punktu za nieparzystość',
  korekta_nieparzystosc: '🛠️ Korekta: punkt za nieparzystość', korekta_nieparzystosc_cofnieta: '🛠️ Korekta: cofnięcie punktu',
  ekipa_dodano: '👋 Dodanie do ekipy', ekipa_usunieto: '🚪 Usunięcie z ekipy', admin_zmiana: '🛠️ Zmiana uprawnień', konfiguracja: '⚙️ Zmiana ustawień',
};
function histLine(h, withSession = false) {
  const d = h.details || {};
  const bits = [];
  if (h.kind === 'wynik' || h.kind === 'korekta') {
    if (d.obecny === false) bits.push('nieobecność'); else if (d.obecny) bits.push('obecność');
    if (d.wygrana != null) bits.push(d.wygrana ? 'wygrana' : 'bez wygranej');
    if (d.nie_wyzywa != null) bits.push(d.nie_wyzywa ? '🕊️ nie wyzywa' : 'wyzywa');
  }
  if (h.kind === 'konfiguracja') bits.push(`okno ${d.okno_wpisu_h} h`);
  if (h.kind === 'ekipa_dodano') bits.push(d.email);
  const target = h.target_id ? ` → <b>${esc(name(h.target_id))}</b>` : '';
  return `<div class="hist"><div>${KIND[h.kind] || esc(h.kind)}${target}${bits.length ? ` <span class="muted">(${esc(bits.join(', '))})</span>` : ''}</div>
    <div class="when">${fDT(h.at)} · ${esc(h.actor_id ? name(h.actor_id) : 'system')}${withSession && h.session_id ? ` · <a href="#/s/${h.session_id}" style="text-decoration:underline">sesja</a>` : ''}</div>
    ${h.reason ? `<div class="why">Powód: ${esc(h.reason)}</div>` : ''}</div>`;
}

async function viewRules() {
  const e = S.config.entry_window_hours;
  return `<div class="topbar"><a class="back" href="#/wiecej">‹</a><h1 style="margin:0">Zasady</h1></div>
  <div class="card small" style="line-height:1.6">
    <b>Punkty</b> — każdy warunek to 1 pkt, ale <b>max 1 punkt na osobę na sesję</b>:
    <ul style="margin:6px 0 12px;padding-left:18px">
      <li>wygrana drużyny (tylko sesje ekipowe),</li><li>MVP sesji (głosowanie),</li><li>wygrany pojedynek 1v1,</li>
      <li>premia za powrót — pierwsza obecność po min. 4 kolejnych sesjach bez gry,</li><li>punkt za nieparzystość (przyznaje lider).</li>
    </ul>
    <b>Remis</b> w MVP lub pojedynku = nikt nie dostaje punktu. Pojedynek bez głosów = bez punktów.<br><br>
    <b>Typy sesji</b><br>${typeChip('ekipowa')} ${typeHint('ekipowa')}<br>${typeChip('mieszana')} ${typeHint('mieszana')}<br>${typeChip('randomy')} ${typeHint('randomy')}<br><br>
    <b>Pojedynki</b> — wyzwać może każdy każdego z ekipy. Akceptacja do połowy sesji, inaczej wyzwanie wygasa. Zaakceptowany pojedynek można wycofać do końca sesji. Głosują obecni na sesji poza dwójką z pojedynku, przez ${S.config.vote_window_hours} h od końca sesji.<br><br>
    <b>MVP</b> — głosują obecni na sesji (nie na siebie), przez ${S.config.vote_window_hours} h od końca sesji.<br><br>
    <b>„Nie chcę wyzywać”</b> — widoczne w rankingu. Osoba bez pary z tym oznaczeniem nie dostaje punktu za nieparzystość.<br><br>
    <b>Wyniki</b> — wpisuje lider albo każdy sam za siebie, przez ${e} h od startu sesji. Jeśli lider nie zatwierdzi wyników w tym czasie, każdy może wpisać swoje do startu następnej sesji. Potem wyniki są zablokowane; korekty robi administrator (z powodem w historii).<br><br>
    <b>Ranking</b> jest roczny, liczony od 1 stycznia, na żywo z zapisanych głosów i wyników.
  </div>`;
}

/* ================= akcje ================= */
async function setPart(uid, present, teamWon = null, noChallenge = null, btn = null) {
  const c = S.cur; if (!c) return false;
  let reason = null;
  if (!c.canEdit(uid)) {
    if (!c.isAdmin) { toast('Wyniki tej sesji są zablokowane', 'err'); return false; }
    reason = c.corrReason || await askReason('Korekta administratora', 'Korekta po uzgodnieniu z grupą. Powód zapisze się w historii.');
    if (!reason) return false;
  }
  const r = await rpc('set_participant', { p_session: c.s.id, p_user: uid, p_present: present, p_team_won: teamWon, p_no_challenge: noChallenge, p_reason: reason }, btn);
  if (r.ok) await render(true);
  return r.ok;
}

const actions = {
  'login': async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) toast(error.message, 'err');
  },
  'logout': async () => { await sb.auth.signOut(); },
  'reload': () => location.reload(),
  'close-sheet': () => closeSheet(),
  'new-session': () => openSheet(sessionForm(null), 'session'),
  'edit-session': () => openSheet(sessionForm(S.cur.s), 'session'),
  'seg': (el) => {
    const form = el.closest('form');
    form.querySelector(`input[name="${el.dataset.name}"]`).value = el.dataset.value;
    el.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
    if (el.dataset.name === 'type') {
      form.querySelector('#randOpts').hidden = el.dataset.value !== 'randomy';
      form.querySelector('#typeHint').textContent = typeHint(el.dataset.value);
    }
  },
  'form-toggle': (el) => {
    const inp = el.closest('form').querySelector(`input[name="${el.dataset.name}"]`);
    const v = inp.value !== 'true';
    inp.value = String(v); el.classList.toggle('on', v);
  },
  'delete-session': async (el) => {
    const reason = await askReason('Usunąć sesję?', 'Sesja zniknie razem z głosami i pojedynkami. Wpis zostanie w historii.');
    if (!reason) return;
    const r = await rpc('delete_session', { p_session: el.dataset.id, p_reason: reason });
    if (r.ok) { toast('Sesja usunięta'); location.hash = '#/sesje'; }
  },
  'join': async (el) => { if (await setPart(S.me.id, true, null, null, el)) { burst(['🏐', '🔥', '✨']); toast('Jesteś w składzie!'); } },
  'leave': async (el) => { if (confirm('Usunąć Cię ze składu tej sesji?')) await setPart(S.me.id, false, null, null, el); },
  'toggle-nc': async (el) => {
    const v = !S.cur.myPart.no_challenge;
    el.classList.toggle('on', v);
    if (await setPart(S.me.id, true, null, v)) { if (v) burst(['🕊️'], 6); }
    else el.classList.toggle('on', !v);
  },
  'toggle-win': async (el) => {
    const uid = el.dataset.uid;
    const p = S.cur.parts.find((x) => x.user_id === uid);
    const v = !p?.team_won;
    if (await setPart(uid, true, v, null, el)) { if (v) { burst(['🏆', '✨']); floatText('+1'); } }
  },
  'roster': async () => {
    const c = S.cur;
    if (!(c.isLeader && c.leadOpen) && c.isAdmin && !c.corrReason) {
      const reason = await askReason('Korekta składu', 'Podaj powód — dotyczy wszystkich zmian w tym oknie.');
      if (!reason) return;
      c.corrReason = reason;
    }
    openRoster();
  },
  'roster-present': async (el) => {
    const uid = el.dataset.uid;
    const present = !S.cur.parts.some((p) => p.user_id === uid);
    el.classList.toggle('on', present);
    if (!(await setPart(uid, present))) el.classList.toggle('on', !present);
    else if (present) burst(['🏐'], 5);
  },
  'submit-results': async (el) => {
    if (!confirm('Zatwierdzić wyniki? Po zatwierdzeniu uczestnicy nie dopiszą już wyników po upływie okna.')) return;
    const r = await rpc('submit_results', { p_session: S.cur.s.id }, el);
    if (r.ok) { burst(['✅', '🏐']); toast('Wyniki zatwierdzone'); render(true); }
  },
  'challenge-pick': () => {
    const c = S.cur;
    const busy = new Set(c.duels.filter((d) => d.status === 'accepted').flatMap((d) => [d.challenger_id, d.challenged_id]));
    const pendingWith = new Set(c.duels.filter((d) => d.status === 'pending' && (d.challenger_id === S.me.id || d.challenged_id === S.me.id)).flatMap((d) => [d.challenger_id, d.challenged_id]));
    const others = S.members.filter((m) => m.id !== S.me.id)
      .sort((a, b) => c.pSet.has(b.id) - c.pSet.has(a.id) || a.display_name.localeCompare(b.display_name, 'pl'));
    openSheet(`<h3>⚔️ Kogo wyzywasz?</h3>
      <p class="small muted">Wyzwanie musi zostać przyjęte do ${fTime(c.T.mid)}.</p>
      <div class="list">${others.map((m) => {
        const p = c.parts.find((x) => x.user_id === m.id);
        const dis = busy.has(m.id) || pendingWith.has(m.id);
        return `<button class="item tap" style="width:100%;text-align:left;cursor:pointer;${dis ? 'opacity:.45;pointer-events:none' : ''}" data-action="challenge" data-uid="${m.id}">
          ${av(m.id, 'sm')}<div class="grow"><b>${esc(m.display_name)}</b><div class="tiny muted">${busy.has(m.id) ? 'ma już pojedynek' : pendingWith.has(m.id) ? 'wyzwanie czeka' : p ? (p.no_challenge ? 'w składzie · 🕊️ nie wyzywa' : 'w składzie') : 'jeszcze nie w składzie'}</div></div><span>⚔️</span></button>`;
      }).join('')}</div>`, 'challenge');
  },
  'challenge': async (el) => {
    const r = await rpc('challenge', { p_session: S.cur.s.id, p_opponent: el.dataset.uid }, el);
    if (r.ok) { closeSheet(); burst(['⚔️', '💥', '🔥'], 14); toast(`Wyzwanie wysłane do ${name(el.dataset.uid)}!`); render(true); }
  },
  'duel-accept': async (el) => {
    const r = await rpc('respond_duel', { p_duel: el.dataset.id, p_accept: true }, el);
    if (r.ok) { burst(['⚔️', '🤝', '🔥'], 14); toast('Pojedynek przyjęty — powodzenia!'); render(true); }
  },
  'duel-decline': async (el) => {
    const r = await rpc('respond_duel', { p_duel: el.dataset.id, p_accept: false }, el);
    if (r.ok) { toast('Wyzwanie odrzucone'); render(true); }
  },
  'duel-withdraw': async (el) => {
    if (!confirm('Wycofać? Tego nie da się cofnąć.')) return;
    const r = await rpc('withdraw_duel', { p_duel: el.dataset.id }, el);
    if (r.ok) { toast('Wycofano'); render(true); }
  },
  'vote-duel': async (el) => {
    const unvote = el.classList.contains('on');
    const r = await rpc('vote_duel', { p_duel: el.dataset.id, p_winner: unvote ? null : el.dataset.uid }, el);
    if (r.ok) { if (!unvote) { burst(['🗳️', '✨'], 8); toast(`Głos na ${name(el.dataset.uid)}`); } else toast('Głos cofnięty'); render(true); }
  },
  'vote-mvp': async (el) => {
    const unvote = el.classList.contains('on');
    el.classList.add('pop');
    const r = await rpc('vote_mvp', { p_session: S.cur.s.id, p_candidate: unvote ? null : el.dataset.uid });
    if (r.ok) { if (!unvote) { burst(['👑', '✨'], 10); toast(`Głos na MVP: ${name(el.dataset.uid)}`); } else toast('Głos cofnięty'); render(true); }
  },
  'award-odd': async (el) => {
    const reason = await askReason(`+1 za grę dla ${name(el.dataset.uid)}`, 'Np. „dobra gra, uzgodnione z ekipą”. Zapisze się w historii.');
    if (!reason) return;
    const r = await rpc('award_odd', { p_session: S.cur.s.id, p_user: el.dataset.uid, p_reason: reason });
    if (r.ok) { burst(['⭐', '✨']); floatText('+1'); render(true); }
  },
  'revoke-odd': async (el) => {
    let reason = null;
    if (!(S.cur.isLeader && S.cur.leadOpen)) { reason = await askReason('Cofnięcie punktu (korekta)'); if (!reason) return; }
    else if (!confirm('Cofnąć punkt?')) return;
    const r = await rpc('revoke_odd', { p_session: S.cur.s.id, p_user: el.dataset.uid, p_reason: reason });
    if (r.ok) { toast('Punkt cofnięty'); render(true); }
  },
  'rename': () => openSheet(`<h3>Twoja nazwa w rankingu</h3><form data-form="rename">
      <label class="f"><span>Nazwa</span><input class="input" name="name" required minlength="2" maxlength="40" value="${esc(S.me.display_name)}"></label>
      <button class="btn primary block">Zapisz</button></form>`, 'rename'),
  'cfg-hours': async (el) => {
    const c = S.config;
    const r = await rpc('admin_set_config', { p_entry_hours: +el.dataset.value, p_randomy_mvp: c.randomy_mvp_default, p_randomy_duels: c.randomy_duels_default }, el);
    if (r.ok) { toast(`Okno wpisu: ${el.dataset.value} h`); render(true); }
  },
  'cfg-toggle': async (el) => {
    const c = { ...S.config }; c[el.dataset.key] = !c[el.dataset.key];
    const r = await rpc('admin_set_config', { p_entry_hours: c.entry_window_hours, p_randomy_mvp: c.randomy_mvp_default, p_randomy_duels: c.randomy_duels_default });
    if (r.ok) render(true);
  },
  'approve': async (el) => {
    const r = await rpc('admin_add_email', { p_email: el.dataset.email, p_admin: false }, el);
    if (r.ok) { burst(['👋', '🏐']); toast('Wpuszczono do ekipy'); render(true); }
  },
  'set-admin': async (el) => {
    const m = S.byId[el.dataset.uid];
    if (!confirm(`${m.is_admin ? 'Odebrać' : 'Nadać'} uprawnienia administratora: ${m.display_name}?`)) return;
    const r = await rpc('admin_set_admin', { p_user: m.id, p_value: !m.is_admin }, el);
    if (r.ok) render(true);
  },
  'remove-member': async (el) => {
    const m = S.byId[el.dataset.uid];
    if (!confirm(`Usunąć ${m.display_name} z ekipy? Historia i punkty zostają, ale ta osoba straci dostęp.`)) return;
    const r = await rpc('admin_remove_member', { p_user: m.id }, el);
    if (r.ok) { toast('Usunięto z ekipy'); render(true); }
  },
};

const forms = {
  async session(form, btn) {
    const f = Object.fromEntries(new FormData(form));
    const start = new Date(`${f.date}T${f.start}`);
    const end = new Date(`${f.date}T${f.end}`);
    if (end <= start) end.setDate(end.getDate() + 1);
    const args = { p_start: start.toISOString(), p_end: end.toISOString(), p_type: f.type, p_leader: f.leader,
      p_mvp: f.type === 'randomy' ? f.mvp === 'true' : null, p_duels: f.type === 'randomy' ? f.duels === 'true' : null, p_note: f.note || null };
    const id = form.dataset.id;
    if (!id) {
      const r = await rpc('create_session', args, btn);
      if (r.ok) { closeSheet(); burst(['🏐', '🎉', '✨'], 16); toast('Sesja utworzona'); location.hash = `#/s/${r.data}`; }
      return;
    }
    let reason = null;
    if (!(S.cur.isLeader && S.cur.leadOpen)) {
      reason = await askReason('Korekta sesji');
      if (!reason) return;
    }
    const r = await rpc('update_session', { p_session: id, ...args, p_reason: reason }, btn);
    if (r.ok) { closeSheet(); toast('Zapisano'); render(true); }
  },
  reason(form) {
    const v = new FormData(form).get('reason').trim();
    if (!v) return;
    const r = sheetResolve; sheetResolve = null;
    closeSheet();
    r?.(v);
  },
  async rename(form, btn) {
    const r = await rpc('update_my_name', { p_name: new FormData(form).get('name') }, btn);
    if (r.ok) { closeSheet(); await loadMembers(); toast('Zapisano'); render(true); }
  },
  async 'add-email'(form, btn) {
    const f = new FormData(form);
    const r = await rpc('admin_add_email', { p_email: f.get('email'), p_admin: f.get('admin') === 'on' }, btn);
    if (r.ok) { burst(['👋']); toast('Dodano — ta osoba może się zalogować'); render(true); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  el.classList.remove('pop'); void el.offsetWidth; if (!el.classList.contains('toggle')) el.classList.add('pop');
  fn(el);
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(form, form.querySelector('button:not([type="button"])'));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

boot();
})();
