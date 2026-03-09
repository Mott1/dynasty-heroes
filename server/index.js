require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const redis = require('redis');
const connectRedis = require('connect-redis');
const RedisStore = connectRedis.default || connectRedis;
const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const YAHOO_AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_API_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';
const LEAGUE_ID = process.env.LEAGUE_ID || '10514';
const MY_TEAM_ID = process.env.MY_TEAM_ID || '9';
const LEAGUE_KEY = `mlb.l.${LEAGUE_ID}`;

const REQUIRED_ENV = ['YAHOO_CLIENT_ID', 'YAHOO_CLIENT_SECRET', 'YAHOO_REDIRECT_URI', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars:', missing.join(', ')); process.exit(1); }

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// ─── REDIS SESSION STORE ──────────────────────────────────────────────────────
const redisClient = redis.createClient({ url: process.env.REDIS_URL });
redisClient.connect().catch(err => console.error('Redis connect error:', err));
redisClient.on('error', err => console.error('Redis error:', err));
redisClient.on('connect', () => console.log('✓ Redis connected'));

app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

function getBasicAuth() {
  return Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64');
}

async function refreshTokenIfNeeded(req) {
  if (!req.session.tokens) return false;
  const { expires_at, refresh_token } = req.session.tokens;
  if (Date.now() < expires_at - 60000) return true;
  try {
    const params = new URLSearchParams({ grant_type: 'refresh_token', redirect_uri: process.env.YAHOO_REDIRECT_URI, refresh_token });
    const r = await axios.post(YAHOO_TOKEN_URL, params.toString(), {
      headers: { 'Authorization': `Basic ${getBasicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    req.session.tokens = {
      access_token: r.data.access_token,
      refresh_token: r.data.refresh_token || refresh_token,
      expires_at: Date.now() + (r.data.expires_in * 1000)
    };
    return true;
  } catch (e) { return false; }
}

async function yahooGet(req, p) {
  const ok = await refreshTokenIfNeeded(req);
  if (!ok) throw { status: 401, message: 'Not authenticated' };
  const url = `${YAHOO_API_BASE}${p}${p.includes('?') ? '&' : '?'}format=json`;
  const r = await axios.get(url, { headers: { 'Authorization': `Bearer ${req.session.tokens.access_token}` } });
  return r.data;
}

function handleError(err, res) {
  if (err.status === 401) return res.status(401).json({ error: 'Not authenticated' });
  res.status(500).json({ error: 'Yahoo API error', details: err.response?.data || err.message });
}

// ─── OAUTH ────────────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({ client_id: process.env.YAHOO_CLIENT_ID, redirect_uri: process.env.YAHOO_REDIRECT_URI, response_type: 'code', language: 'en-us' });
  res.redirect(`${YAHOO_AUTH_URL}?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const params = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.YAHOO_REDIRECT_URI });
    const r = await axios.post(YAHOO_TOKEN_URL, params.toString(), {
      headers: { 'Authorization': `Basic ${getBasicAuth()}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    req.session.tokens = { access_token: r.data.access_token, refresh_token: r.data.refresh_token, expires_at: Date.now() + (r.data.expires_in * 1000) };
    res.redirect('/');
  } catch (e) { res.redirect('/?error=auth_failed'); }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });
app.get('/api/status', (req, res) => { res.json({ authenticated: !!(req.session.tokens), myTeamId: MY_TEAM_ID, leagueId: LEAGUE_ID }); });

// ─── ALL-TIME HISTORY ─────────────────────────────────────────────────────────
app.get('/api/history', async (req, res) => {
  try {
    const userData = await yahooGet(req, '/users;use_login=1/games;game_keys=mlb/leagues');
    const gamesArr = userData?.fantasy_content?.users?.[0]?.user?.[1]?.games;
    if (!gamesArr) return res.status(500).json({ error: 'Could not fetch user leagues' });
    const leagueKeys = [];
    const count = gamesArr.count || 0;
    for (let i = 0; i < count; i++) {
      const game = gamesArr[i]?.game;
      if (!game) continue;
      const gameInfo = Array.isArray(game) ? game[0] : game;
      const leaguesData = Array.isArray(game) ? game[1]?.leagues : null;
      if (!leaguesData) continue;
      const lc = leaguesData.count || 0;
      for (let j = 0; j < lc; j++) {
        const league = leaguesData[j]?.league;
        if (!league) continue;
        const info = Array.isArray(league) ? league[0] : league;
        if (info.name === 'Dynasty Heroes') leagueKeys.push({ key: info.league_key, season: info.season || gameInfo.season });
      }
    }
    if (leagueKeys.length === 0) return res.status(404).json({ error: 'No historical leagues found' });
    const historyByYear = [];
    for (const { key, season } of leagueKeys) {
      try {
        const data = await yahooGet(req, `/league/${key}/standings`);
        const leagueArr = data?.fantasy_content?.league;
        if (!leagueArr) continue;
        const teams = leagueArr[1]?.standings?.[0]?.teams;
        if (!teams) continue;
        const tc = teams.count || 0;
        const yearTeams = [];
        for (let i = 0; i < tc; i++) {
          const team = teams[i]?.team;
          if (!team) continue;
          const info = team[0];
          const standings = team[2]?.team_standings;
          const teamArr = Array.isArray(info) ? info : [info];
          const nameObj = teamArr.find(x => x?.name);
          const logoArr = teamArr.find(x => Array.isArray(x?.team_logos));
          const managerObj = teamArr.find(x => x?.managers);
          yearTeams.push({
            name: nameObj?.name || 'Unknown',
            logo: logoArr?.team_logos?.[0]?.team_logo?.url || null,
            manager: managerObj?.managers?.[0]?.manager?.nickname || '',
            rank: parseInt(standings?.rank) || 99,
            wins: parseInt(standings?.outcome_totals?.wins) || 0,
            losses: parseInt(standings?.outcome_totals?.losses) || 0,
            ties: parseInt(standings?.outcome_totals?.ties) || 0,
            pct: parseFloat(standings?.outcome_totals?.percentage) || 0,
          });
        }
        yearTeams.sort((a, b) => a.rank - b.rank);
        historyByYear.push({ season: parseInt(season), leagueKey: key, teams: yearTeams });
      } catch (e) { console.error(`Failed standings for ${key}:`, e.message); }
    }
    historyByYear.sort((a, b) => b.season - a.season);
    res.json({ seasons: historyByYear });
  } catch (err) { handleError(err, res); }
});

// ─── RAW PROXY ────────────────────────────────────────────────────────────────
app.get('/api/raw', async (req, res) => {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).json({ error: 'path required' });
    res.json(await yahooGet(req, p));
  } catch (err) { handleError(err, res); }
});

// ─── CURRENT LEAGUE ───────────────────────────────────────────────────────────
app.get('/api/league', async (req, res) => {
  try {
    const data = await yahooGet(req, `/league/${LEAGUE_KEY};out=settings,standings`);
    const league = data?.fantasy_content?.league;
    if (!league) return res.status(500).json({ error: 'No league data' });
    const settings = league[0];
    const teamsData = league[1]?.standings?.[0]?.teams;
    const teams = [];
    if (teamsData) {
      const count = teamsData.count || 0;
      for (let i = 0; i < count; i++) {
        const team = teamsData[i]?.team;
        if (!team) continue;
        const info = team[0];
        const standings = team[2]?.team_standings;
        const teamArr = Array.isArray(info) ? info : [info];
        teams.push({
          team_id: teamArr.find(x => x?.team_id)?.team_id,
          name: teamArr.find(x => x?.name)?.name,
          logo: teamArr.find(x => Array.isArray(x?.team_logos))?.team_logos?.[0]?.team_logo?.url,
          rank: standings?.rank, wins: standings?.outcome_totals?.wins,
          losses: standings?.outcome_totals?.losses, ties: standings?.outcome_totals?.ties,
          pct: standings?.outcome_totals?.percentage, streak: standings?.streak,
          moves: standings?.moves, waiver_priority: standings?.waiver_priority
        });
      }
    }
    res.json({ name: settings.name, season: settings.season, num_teams: settings.num_teams, current_week: settings.current_week, start_week: settings.start_week, end_week: settings.end_week, league_url: settings.url, teams });
  } catch (err) { handleError(err, res); }
});

// ─── SCOREBOARD ───────────────────────────────────────────────────────────────
app.get('/api/scoreboard', async (req, res) => {
  try {
    const week = req.query.week || 'current';
    const weekParam = week === 'current' ? '' : `;week=${week}`;
    const data = await yahooGet(req, `/league/${LEAGUE_KEY}/scoreboard${weekParam}`);
    const matchups = data?.fantasy_content?.league?.[1]?.scoreboard?.['0']?.matchups;
    if (!matchups) return res.json({ matchups: [] });
    const result = [];
    for (let i = 0; i < (matchups.count || 0); i++) {
      const matchup = matchups[i]?.matchup;
      if (!matchup) continue;
      const teams = matchup['0']?.teams;
      if (!teams) continue;
      const matchupTeams = [];
      for (let j = 0; j < 2; j++) {
        const team = teams[j]?.team;
        if (!team) continue;
        const info = Array.isArray(team[0]) ? team[0] : [team[0]];
        matchupTeams.push({ name: info.find(x => x?.name)?.name, logo: info.find(x => Array.isArray(x?.team_logos))?.team_logos?.[0]?.team_logo?.url, points: team[1]?.team_points?.total || 0, projected: team[1]?.team_projected_points?.total || 0 });
      }
      result.push({ week: matchup.week, status: matchup.status, teams: matchupTeams });
    }
    res.json({ matchups: result });
  } catch (err) { handleError(err, res); }
});

// ─── TRANSACTIONS ─────────────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    const data = await yahooGet(req, `/league/${LEAGUE_KEY}/transactions;type=add,drop,trade`);
    const trans = data?.fantasy_content?.league?.[1]?.transactions;
    if (!trans) return res.json({ transactions: [] });
    const result = [];
    for (let i = 0; i < Math.min(trans.count || 0, 20); i++) {
      const t = trans[i]?.transaction;
      if (!t) continue;
      const info = t[0];
      const players = t[1]?.players;
      const playerList = [];
      if (players) {
        for (let j = 0; j < (players.count || 0); j++) {
          const p = players[j]?.player;
          if (!p) continue;
          const pinfo = p[0];
          const ptrans = p[1]?.transaction_data;
          const nameObj = Array.isArray(pinfo) ? pinfo.find(x => x?.full) : null;
          playerList.push({ name: nameObj?.full || 'Unknown', type: ptrans?.[0]?.type || '', source_team: ptrans?.[0]?.source_team_name || '', dest_team: ptrans?.[0]?.destination_team_name || '' });
        }
      }
      result.push({ type: info.type, timestamp: info.timestamp, players: playerList });
    }
    res.json({ transactions: result });
  } catch (err) { handleError(err, res); }
});

// ─── TEAM ROSTER ──────────────────────────────────────────────────────────────
app.get('/api/teams/:teamId/roster', async (req, res) => {
  try {
    const { teamId } = req.params;
    const teamKey = `${LEAGUE_KEY}.t.${teamId}`;
    const data = await yahooGet(req, `/team/${teamKey}/roster;out=players`);
    const teamData = data?.fantasy_content?.team;
    if (!teamData) return res.status(404).json({ error: 'Team not found' });
    const teamInfo = Array.isArray(teamData[0]) ? teamData[0] : [teamData[0]];
    const teamName = teamInfo.find(x => x?.name)?.name || `Team ${teamId}`;
    const rosterData = teamData[1]?.roster;
    const playersData = rosterData?.['0']?.players;
    const players = [];
    if (playersData) {
      const count = playersData.count || 0;
      for (let i = 0; i < count; i++) {
        const player = playersData[i]?.player;
        if (!player) continue;
        const pinfo = Array.isArray(player[0]) ? player[0] : [player[0]];
        const nameObj = pinfo.find(x => x?.full_name || x?.name);
        const posObj = pinfo.find(x => Array.isArray(x?.eligible_positions));
        const selPosObj = pinfo.find(x => x?.selected_position);
        const name = nameObj?.full_name || nameObj?.name?.full || 'Unknown';
        const eligible = posObj?.eligible_positions?.map(p => p?.position).filter(Boolean) || [];
        const selected = selPosObj?.selected_position?.[1]?.position || eligible[0] || '';
        players.push({ name, eligible_positions: eligible, selected_position: selected });
      }
    }
    res.json({ team_id: teamId, team_name: teamName, players });
  } catch (err) { handleError(err, res); }
});

// ─── AI PROXY (Claude Haiku — no rate limits) ─────────────────────────────────
// Replaces the old /api/groq route. Uses your existing ANTHROPIC_API_KEY.
// Claude Haiku is ~100x cheaper than GPT-4 and has no per-minute token caps.
app.post('/api/groq', async (req, res) => {
  if (!req.session?.tokens) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  try {
    const { messages, max_tokens, stream } = req.body;

    // Separate system message from user messages (Claude API format)
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');

    const payload = {
      model: 'claude-haiku-4-5',
      max_tokens: max_tokens || 4096,
      system: systemMsg?.content || 'You are a helpful assistant.',
      messages: userMessages,
      stream: stream || false,
    };

    const claudeRes = await axios.post(
      'https://api.anthropic.com/v1/messages',
      payload,
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        responseType: stream ? 'stream' : 'json',
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');

      // Translate Claude's SSE format → Groq-compatible SSE format
      // so the existing frontend parsing code keeps working unchanged
      claudeRes.data.on('data', chunk => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const evt = JSON.parse(raw);
            // Claude sends content_block_delta events with the actual text
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              const groqFormat = {
                choices: [{ delta: { content: evt.delta.text } }]
              };
              res.write(`data: ${JSON.stringify(groqFormat)}\n\n`);
            }
            // Signal end of stream
            if (evt.type === 'message_stop') {
              res.write('data: [DONE]\n\n');
            }
          } catch {}
        }
      });
      claudeRes.data.on('end', () => res.end());
      claudeRes.data.on('error', () => res.end());

    } else {
      // Translate Claude's response format → Groq-compatible format
      // so the existing frontend keeps working unchanged
      const content = claudeRes.data.content?.[0]?.text || '';
      res.json({
        choices: [{ message: { role: 'assistant', content } }]
      });
    }

  } catch (err) {
    const status = err.response?.status || 500;
    const msg = err.response?.data?.error?.message || err.message;
    console.error('Claude API error:', status, msg);
    res.status(status).json({ error: msg });
  }
});

// ─── KEEP OLD /api/claude ROUTE TOO (unchanged) ───────────────────────────────
app.post('/api/claude', async (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', req.body, {
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      responseType: req.body.stream ? 'stream' : 'json',
    });
    if (req.body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      response.data.pipe(res);
    } else {
      res.json(response.data);
    }
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.listen(PORT, () => console.log(`\n✓ Dynasty Heroes running on port ${PORT}\n`));
