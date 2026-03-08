require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const YAHOO_AUTH_URL  = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_API_BASE  = 'https://fantasysports.yahooapis.com/fantasy/v2';
const LEAGUE_ID       = process.env.LEAGUE_ID  || '10514';
const MY_TEAM_ID      = process.env.MY_TEAM_ID || '9';
const LEAGUE_KEY      = `mlb.l.${LEAGUE_ID}`;
const MLB_GAME_KEYS   = '357,370,378,388,398,404,412,422,431,458,469';

const REQUIRED_ENV = ['YAHOO_CLIENT_ID', 'YAHOO_CLIENT_SECRET', 'YAHOO_REDIRECT_URI', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) { console.error('Missing env vars: ' + missing.join(', ')); process.exit(1); }

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 86400000, httpOnly: true } }));
app.set('trust proxy', 1);

function basicAuthHeader() { return 'Basic ' + Buffer.from(process.env.YAHOO_CLIENT_ID + ':' + process.env.YAHOO_CLIENT_SECRET).toString('base64'); }
async function exchangeToken(params) { const res = await axios.post(YAHOO_TOKEN_URL, new URLSearchParams(params).toString(), { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }); return res.data; }
async function getAccessToken(req) {
  if (!req.session.tokens) { const e = new Error('NOT_AUTHENTICATED'); e.code = 'NOT_AUTHENTICATED'; throw e; }
  const { access_token, refresh_token, expires_at } = req.session.tokens;
  if (Date.now() < expires_at - 300000) return access_token;
  try {
    const d = await exchangeToken({ grant_type: 'refresh_token', redirect_uri: process.env.YAHOO_REDIRECT_URI, refresh_token });
    req.session.tokens = { access_token: d.access_token, refresh_token: d.refresh_token || refresh_token, expires_at: Date.now() + d.expires_in * 1000 };
    return d.access_token;
  } catch(e) { req.session.destroy(()=>{}); const err=new Error('NOT_AUTHENTICATED'); err.code='NOT_AUTHENTICATED'; throw err; }
}
async function yahooGet(req, urlPath) {
  const token = await getAccessToken(req);
  const url = YAHOO_API_BASE + urlPath + (urlPath.includes('?') ? '&' : '?') + 'format=json';
  const res = await axios.get(url, { headers: { Authorization: 'Bearer ' + token }, timeout: 20000 });
  return res.data;
}
function handleError(err, res) {
  if (err.code === 'NOT_AUTHENTICATED' || err.message === 'NOT_AUTHENTICATED') return res.status(401).json({ error: 'not_authenticated' });
  const status = err.response?.status || 500;
  const message = err.response?.data?.error?.description || err.response?.data || err.message || 'Unknown error';
  console.error('API Error [' + status + ']:', message);
  res.status(status).json({ error: 'api_error', message: String(message) });
}

app.get('/auth/login', (_req, res) => { const p = new URLSearchParams({ client_id: process.env.YAHOO_CLIENT_ID, redirect_uri: process.env.YAHOO_REDIRECT_URI, response_type: 'code', language: 'en-us' }); res.redirect(YAHOO_AUTH_URL + '?' + p); });
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?auth_error=1');
  try { const d = await exchangeToken({ grant_type: 'authorization_code', redirect_uri: process.env.YAHOO_REDIRECT_URI, code }); req.session.tokens = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() + d.expires_in * 1000 }; res.redirect('/'); }
  catch (err) { console.error('Token exchange failed:', err.response?.data || err.message); res.redirect('/?auth_error=1'); }
});
app.get('/auth/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
app.get('/api/status', (req, res) => { res.json({ authenticated: !!req.session.tokens, myTeamId: MY_TEAM_ID, leagueId: LEAGUE_ID }); });

app.get('/api/league', async (req, res) => {
  try {
    const raw = await yahooGet(req, `/league/${LEAGUE_KEY};out=settings,standings`);
    const league = raw.fantasy_content.league;
    const settings = league[0];
    const standingsBlock = league[1]?.standings?.[0]?.teams;
    const teams = [];
    if (standingsBlock) {
      for (let i = 0; i < standingsBlock.count; i++) {
        const t = standingsBlock[i]?.team; if (!t) continue;
        const infoArr = t[0], statsObj = t[2]?.team_standings;
        const get = key => infoArr.find(x => x[key] !== undefined)?.[key];
        teams.push({ team_key: get('team_key'), team_id: get('team_id'), name: get('name'), logo: get('team_logos')?.[0]?.team_logo?.url||null, manager: get('managers')?.[0]?.manager?.nickname||'', wins: statsObj?.outcome_totals?.wins||'0', losses: statsObj?.outcome_totals?.losses||'0', ties: statsObj?.outcome_totals?.ties||'0', pct: statsObj?.outcome_totals?.percentage||'.000', rank: statsObj?.rank||i+1, streak: statsObj?.streak?.value ? ((statsObj.streak.type==='W'?'W':'L')+statsObj.streak.value) : '—', moves: get('number_of_moves')||'0', waiver: get('waiver_priority')||'—' });
      }
    }
    res.json({ name: settings.name, season: settings.season, num_teams: settings.num_teams, current_week: parseInt(settings.current_week)||1, start_week: parseInt(settings.start_week)||1, end_week: parseInt(settings.end_week)||25, league_url: settings.url, teams });
  } catch(err) { handleError(err, res); }
});

app.get('/api/scoreboard', async (req, res) => {
  try {
    const weekParam = req.query.week ? `;week=${req.query.week}` : '';
    const raw = await yahooGet(req, `/league/${LEAGUE_KEY}/scoreboard${weekParam}`);
    const league = raw.fantasy_content.league, settings = league[0];
    const matchupsRaw = league[1]?.scoreboard?.['0']?.matchups, matchups = [];
    if (matchupsRaw) {
      for (let i = 0; i < matchupsRaw.count; i++) {
        const m = matchupsRaw[i]?.matchup; if (!m) continue;
        const teamsRaw = m['0']?.teams, teams = [];
        if (teamsRaw) { for (let j = 0; j < teamsRaw.count; j++) { const t = teamsRaw[j]?.team; if (!t) continue; const info=t[0],stats=t[1]; const get=key=>info.find(x=>x[key]!==undefined)?.[key]; teams.push({ team_key: get('team_key'), team_id: get('team_id'), name: get('name'), logo: get('team_logos')?.[0]?.team_logo?.url||null, wins: get('team_standings')?.outcome_totals?.wins||'0', losses: get('team_standings')?.outcome_totals?.losses||'0', points: stats?.team_points?.total||'0.00', projected: stats?.team_projected_points?.total||'0.00', win_probability: stats?.win_probability||null }); } }
        matchups.push({ week: m.week||req.query.week||settings.current_week, status: m.status||'pregame', is_tied: m.is_tied||'0', teams });
      }
    }
    res.json({ current_week: parseInt(settings.current_week)||1, week: req.query.week||settings.current_week, matchups });
  } catch(err) { handleError(err, res); }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const raw = await yahooGet(req, `/league/${LEAGUE_KEY}/transactions;types=add,drop,trade;count=20`);
    const txRaw = raw.fantasy_content.league[1]?.transactions, transactions = [];
    if (txRaw) { for (let i=0;i<txRaw.count;i++) { const tx=txRaw[i]?.transaction; if(!tx) continue; const meta=tx[0],players=tx[1]?.players; const txObj={key:meta.transaction_key,type:meta.type,status:meta.status,timestamp:meta.timestamp,players:[]}; if(players){for(let p=0;p<players.count;p++){const player=players[p]?.player;if(!player)continue;const info=player[0];const td=Array.isArray(player[1]?.transaction_data)?player[1].transaction_data[0]:player[1]?.transaction_data;const getInfo=key=>info.find(x=>x[key]!==undefined)?.[key];txObj.players.push({name:getInfo('full_name')||getInfo('name')?.full||'—',team:getInfo('editorial_team_abbr')||'—',position:getInfo('display_position')||'—',tx_type:td?.type,source:td?.source_team_name||td?.source_type||'—',dest:td?.destination_team_name||td?.destination_type||'—'});}} transactions.push(txObj); } }
    res.json({ transactions });
  } catch(err) { handleError(err, res); }
});

app.get('/api/teams/:teamId/roster', async (req, res) => {
  try {
    const teamKey = `mlb.l.${LEAGUE_ID}.t.${req.params.teamId}`;
    const raw = await yahooGet(req, `/team/${teamKey}/roster/players`);
    const team=raw.fantasy_content.team, teamInfo=team[0], playersRaw=team[1]?.roster?.['0']?.players, players=[];
    if (playersRaw) { for(let i=0;i<playersRaw.count;i++){const p=playersRaw[i]?.player;if(!p)continue;const info=p[0],sel=p[1]?.selected_position?.[1]?.position;const get=key=>info.find(x=>x[key]!==undefined)?.[key];players.push({name:get('full_name')||get('name')?.full||'—',team:get('editorial_team_abbr')||'—',position:get('display_position')||'—',status:get('status')||'Active',injury:get('injury_note')||null,selected_position:sel||'—'});} }
    const getTeamInfo = key => teamInfo.find(x=>x[key]!==undefined)?.[key];
    res.json({ team_name: getTeamInfo('name'), players });
  } catch(err) { handleError(err, res); }
});

app.get('/api/history', async (req, res) => {
  try {
    const data = await yahooGet(req, `/users;use_login=1/games;game_keys=${MLB_GAME_KEYS}/leagues`);
    const gamesRaw = data?.fantasy_content?.users?.[0]?.user?.[1]?.games;
    if (!gamesRaw) return res.status(500).json({ error: 'Could not fetch game history' });
    const leagueKeys = [];
    const gameCount = gamesRaw.count || 0;
    for (let i = 0; i < gameCount; i++) {
      const gameArr = gamesRaw[i]?.game;
      if (!Array.isArray(gameArr)) continue;
      const gameInfo = gameArr[0];
      const leaguesRaw = gameArr[1]?.leagues;
      if (!leaguesRaw) continue;
      const lc = leaguesRaw.count || 0;
      for (let j = 0; j < lc; j++) {
        const leagueArr = leaguesRaw[j]?.league;
        if (!Array.isArray(leagueArr)) continue;
        const info = leagueArr[0];
        if (String(info.league_id) === String(LEAGUE_ID) || info.name === 'Dynasty Heroes') {
          leagueKeys.push({ key: info.league_key, season: info.season || gameInfo.season });
        }
      }
    }
    if (leagueKeys.length === 0) return res.status(404).json({ error: 'No Dynasty Heroes history found' });
    const seasons = [];
    for (const { key, season } of leagueKeys) {
      try {
        const d = await yahooGet(req, `/league/${key}/standings`);
        const leagueArr = d?.fantasy_content?.league;
        if (!leagueArr) continue;
        const teamsRaw = leagueArr[1]?.standings?.[0]?.teams;
        if (!teamsRaw) continue;
        const teams = [];
        for (let i = 0; i < (teamsRaw.count || 0); i++) {
          const teamArr = teamsRaw[i]?.team;
          if (!Array.isArray(teamArr)) continue;
          const infoArr = teamArr[0], standing = teamArr[2]?.team_standings;
          const get = k => Array.isArray(infoArr) ? infoArr.find(x => x?.[k] !== undefined)?.[k] : null;
          teams.push({ name: get('name')||'Unknown', logo: get('team_logos')?.[0]?.team_logo?.url||null, manager: get('managers')?.[0]?.manager?.nickname||'', team_id: get('team_id'), rank: parseInt(standing?.rank)||99, wins: parseInt(standing?.outcome_totals?.wins)||0, losses: parseInt(standing?.outcome_totals?.losses)||0, ties: parseInt(standing?.outcome_totals?.ties)||0, pct: parseFloat(standing?.outcome_totals?.percentage)||0 });
        }
        teams.sort((a, b) => a.rank - b.rank);
        seasons.push({ season: parseInt(season), leagueKey: key, teams });
      } catch(e) { console.error(`Standings failed ${key}:`, e.message); }
    }
    seasons.sort((a, b) => b.season - a.season);
    res.json({ seasons });
  } catch(err) { handleError(err, res); }
});


// ─── TEAM ROSTER ─────────────────────────────────────────────────────────────
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
                            const name = nameObj?.full_name || nameObj?.name?.full || 'Unknown';
                            const eligible = posObj?.eligible_positions?.map(p => p?.position).filter(Boolean) || [];
                            players.push({ name, eligible_positions: eligible });
                  }
          }
          res.json({ team_id: teamId, team_name: teamName, players });
    } catch (err) { handleError(err, res); }
});

// ─── CLAUDE PROXY (avoids CORS) ───────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
    if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
    try {
          const response = await axios.post(
                  'https://api.anthropic.com/v1/messages',
                  req.body,
            {
                      headers: {
                                  'x-api-key': process.env.ANTHROPIC_API_KEY,
                                  'anthropic-version': '2023-06-01',
                                  'content-type': 'application/json',
                      },
                      responseType: req.body.stream ? 'stream' : 'json',
            }
                );
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
app.get('/api/raw', async (req, res) => { try { const p=req.query.path; if(!p) return res.status(400).json({error:'path required'}); res.json(await yahooGet(req,p)); } catch(err){handleError(err,res);} });
app.get('*', (_req, res) => { res.sendFile(path.join(__dirname, '../public/index.html')); });
app.listen(PORT, () => { console.log('Dynasty Heroes running on port ' + PORT); });
