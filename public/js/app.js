/**
 * Dynasty Heroes — Frontend
 * Fetches data from the Node.js backend and renders the UI.
 */

// ── TEAM EMOJI FALLBACKS ─────────────────────────────────────────────────────
const EMOJI = {
  'BallBusters':           '💥',
  'Kramerica':             '🤝',
  'Ratt Pack':             '🐀',
  'Pudge⚾🐶 RM':          '🐶',
  'PANDA POWER!!!':        '🐼',
  'New York Stratomatic':  '🗽',
  'Business Jortz':        '💼',
  'L7 Weenies':            '🌭',
  'Kekambas':              '🦅',
  "Bazooka Joe's":         '🍬',
  'Good Wood':             '🪵',
  'El Gallo':              '🐓',
  'Dugout Dandies RM':     '🎩',
  'Double Shock Power':    '⚡',
  'Momen':                 '🌀',
  'Bubb Rubbs':            '🎺',
  'Beisbol Academy':       '🏫',
  '⚾⚾Ball Four⚾⚾':      '⚾',
};

// ── STATE ─────────────────────────────────────────────────────────────────────
const S = {
  myTeamId:    null,
  currentWeek: 1,
  maxWeek:     25,
  activeTab:   'standings',
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
const $   = id => document.getElementById(id);
const esc = s  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function show(id) { const el = $(id); if (el) el.style.display = ''; }
function hide(id) { const el = $(id); if (el) el.style.display = 'none'; }

function setSpinner(on) { on ? show('spinner') : hide('spinner'); }

function showError(msg) {
  hide('spinner');
  $('error-text').textContent = msg || 'Something went wrong. Check server logs.';
  show('error-banner');
}
function hideError() { hide('error-banner'); }

async function apiFetch(url) {
  const res = await fetch(url);
  if (res.status === 401) throw Object.assign(new Error('NOT_AUTHENTICATED'), { code: 401 });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return res.json();
}

function tsToDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(Number(ts) * 1000);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  } catch { return ''; }
}

function logoHtml(url, name, cls) {
  const em = EMOJI[name] || '⚾';
  if (url) {
    return `<img class="${cls}" src="${esc(url)}" alt="${esc(name)}"
              onerror="this.replaceWith(Object.assign(document.createElement('div'),
                {className:'${cls.replace('logo','logo-ph')}',textContent:'${em}'}))">`;
  }
  return `<div class="${cls.replace('logo','logo-ph')}">${em}</div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Show auth error if redirected back with error
  if (location.search.includes('auth_error=1')) {
    show('screen-login');
    show('login-error-msg');
    return;
  }

  let status;
  try { status = await apiFetch('/api/status'); }
  catch { status = { authenticated: false }; }

  if (!status.authenticated) {
    show('screen-login');
    return;
  }

  S.myTeamId = String(status.myTeamId || '9');

  show('screen-app');
  initTabs();
  initWeekNav();
  await loadLeague();
});

// ── TABS ──────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === S.activeTab) return;
      switchTab(btn.dataset.tab);
    });
  });
}

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  ['standings','scoreboard','transactions'].forEach(t => {
    const el = $(`panel-${t}`);
    if (el) el.style.display = t === name ? '' : 'none';
  });
  S.activeTab = name;
  hideError();

  if (name === 'scoreboard')   loadScoreboard(S.currentWeek);
  if (name === 'transactions') loadTransactions();
}

// ── WEEK NAV ──────────────────────────────────────────────────────────────────
function initWeekNav() {
  $('btn-prev-week').addEventListener('click', () => {
    if (S.currentWeek > 1) { S.currentWeek--; syncWeekUI(); loadScoreboard(S.currentWeek); }
  });
  $('btn-next-week').addEventListener('click', () => {
    if (S.currentWeek < S.maxWeek) { S.currentWeek++; syncWeekUI(); loadScoreboard(S.currentWeek); }
  });
}

function syncWeekUI() {
  $('week-display').textContent       = `Week ${S.currentWeek}`;
  $('btn-prev-week').disabled         = S.currentWeek <= 1;
  $('btn-next-week').disabled         = S.currentWeek >= S.maxWeek;
}

// ── LEAGUE / STANDINGS ────────────────────────────────────────────────────────
async function loadLeague() {
  setSpinner(true); hideError();
  try {
    const data = await apiFetch('/api/league');

    S.currentWeek = data.current_week || 1;
    S.maxWeek     = data.end_week     || 25;
    syncWeekUI();

    $('hdr-league-name').textContent = data.name || 'Dynasty Heroes';
    $('hdr-week-label').textContent  = `Week ${S.currentWeek} · ${data.season} Season`;
    $('season-tag').textContent      = `${data.season} Season`;
    $('standings-meta').textContent  = `${data.num_teams} teams · ${data.season} season`;

    renderStandings(data.teams || []);
    setSpinner(false);
  } catch (err) {
    setSpinner(false);
    if (err.code === 401) { location.href = '/auth/login'; return; }
    showError(`Standings failed: ${err.message}`);
  }
}

function renderStandings(teams) {
  const tbody = $('standings-body');

  if (!teams.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted);font-family:'DM Mono',monospace;font-size:11px">
      No standings data yet — season hasn't started</td></tr>`;
    return;
  }

  tbody.innerHTML = teams.map((t, i) => {
    const rank   = Number(t.rank) || i + 1;
    const rankCls= rank===1 ? 'r1' : rank===2 ? 'r2' : rank===3 ? 'r3' : '';
    const isMe   = String(t.team_id) === S.myTeamId;

    return `<tr>
      <td class="col-rank ${rankCls}">${rank}</td>
      <td>
        <div class="team-cell">
          ${logoHtml(t.logo, t.name, 'team-logo')}
          <div class="team-info">
            <span class="team-name ${isMe?'me':''}">
              ${esc(t.name)}${isMe ? '<span class="me-tag">Me</span>' : ''}
            </span>
            <span class="team-mgr">${esc(t.manager)}</span>
          </div>
        </div>
      </td>
      <td>${t.wins}</td>
      <td>${t.losses}</td>
      <td>${t.ties}</td>
      <td class="col-pct">${t.pct}</td>
      <td class="hide-sm">${t.streak}</td>
      <td class="hide-sm">${t.moves}</td>
      <td class="hide-sm">${t.waiver}</td>
    </tr>`;
  }).join('');
}

// ── SCOREBOARD ────────────────────────────────────────────────────────────────
async function loadScoreboard(week) {
  const grid = $('matchups-grid');
  grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);
    font-family:'DM Mono',monospace;font-size:11px;letter-spacing:.08em">
    <div class="spinner" style="margin:0 auto 12px"></div>Loading matchups…</div>`;

  try {
    const data = await apiFetch(`/api/scoreboard?week=${week}`);
    renderMatchups(data.matchups || [], week);
  } catch (err) {
    if (err.code === 401) { location.href = '/auth/login'; return; }
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);
      font-family:'DM Mono',monospace;font-size:11px">Error: ${esc(err.message)}</div>`;
  }
}

function renderMatchups(matchups, week) {
  const grid = $('matchups-grid');

  if (!matchups.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);
      font-family:'DM Mono',monospace;font-size:11px">No matchup data for Week ${week} yet</div>`;
    return;
  }

  grid.innerHTML = matchups.map((m, idx) => {
    const [t1, t2] = m.teams;
    if (!t1 || !t2) return '';

    const isMyMatchup = [t1,t2].some(t => String(t.team_id) === S.myTeamId);

    const statusLabel = { postevent:'Final', midevent:'Live', pregame:'Upcoming' }[m.status] || 'Upcoming';
    const pipCls      = { postevent:'final', midevent:'live', pregame:'pregame' }[m.status]  || 'pregame';

    const hasScores = parseFloat(t1.points) > 0 || parseFloat(t2.points) > 0;
    const t1Leading = hasScores && parseFloat(t1.points) > parseFloat(t2.points);
    const t2Leading = hasScores && parseFloat(t2.points) > parseFloat(t1.points);

    const teamHtml = (t, leading) => {
      const isMe = String(t.team_id) === S.myTeamId;
      const scoreOrRecord = hasScores
        ? `<div class="mu-score ${leading?'leading':''}">${t.points}</div>`
        : `<div class="mu-record">${t.wins}-${t.losses}</div>`;
      return `<div class="mu-team">
        ${logoHtml(t.logo, t.name, 'mu-logo')}
        <div class="mu-name ${isMe?'me':''}">${esc(t.name)}</div>
        ${scoreOrRecord}
      </div>`;
    };

    return `<div class="matchup-card ${isMyMatchup?'mine':''}" style="animation-delay:${idx*.05+.04}s">
      ${isMyMatchup ? '<div class="mine-tag">My Matchup</div>' : ''}
      <div class="matchup-body">
        ${teamHtml(t1, t1Leading)}
        <div class="vs-sep">VS</div>
        ${teamHtml(t2, t2Leading)}
      </div>
      <div class="matchup-foot">
        <div class="status-pip ${pipCls}"></div>
        <span class="status-text">${statusLabel} · Week ${m.week || week}</span>
      </div>
    </div>`;
  }).join('');
}

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
async function loadTransactions() {
  const feed = $('tx-feed');
  feed.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);
    font-family:'DM Mono',monospace;font-size:11px">
    <div class="spinner" style="margin:0 auto 12px"></div>Loading…</div>`;

  try {
    const data = await apiFetch('/api/transactions');
    renderTransactions(data.transactions || []);
  } catch (err) {
    if (err.code === 401) { location.href = '/auth/login'; return; }
    feed.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);
      font-family:'DM Mono',monospace;font-size:11px">Error: ${esc(err.message)}</div>`;
  }
}

function renderTransactions(transactions) {
  const feed = $('tx-feed');

  if (!transactions.length) {
    feed.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);
      font-family:'DM Mono',monospace;font-size:11px">No transactions yet</div>`;
    return;
  }

  feed.innerHTML = transactions.map((tx, i) => {
    const type = tx.type || 'add';
    const date = tsToDate(tx.timestamp);

    // Build a human-readable description
    let playerName = '—', detail = '';

    if (type === 'trade') {
      const names = tx.players.slice(0, 3).map(p => p.name).filter(Boolean);
      playerName = 'Trade';
      detail = names.join(' · ');
    } else {
      const p = tx.players[0];
      if (p) {
        playerName = p.name;
        const pos  = [p.team, p.position].filter(x => x && x !== '—').join(' — ');
        const dest = p.dest && p.dest !== '—' ? ` → ${p.dest}` : '';
        detail = pos + dest;
      }
    }

    return `<div class="tx-row" style="animation-delay:${i*.04+.04}s">
      <span class="tx-pill ${type}">${type}</span>
      <div class="tx-body">
        <div class="tx-player">${esc(playerName)}</div>
        <div class="tx-detail">${esc(detail)}</div>
      </div>
      <div class="tx-time">${esc(date)}</div>
    </div>`;
  }).join('');
}
