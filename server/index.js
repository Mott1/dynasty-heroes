require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const YAHOO_AUTH_URL  = 'https://api.login.yahoo.com/oauth2/request_auth';
const YAHOO_TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const YAHOO_API_BASE  = 'https://fantasysports.yahooapis.com/fantasy/v2';
const LEAGUE_ID       = process.env.LEAGUE_ID  || '10514';
const MY_TEAM_ID      = process.env.MY_TEAM_ID || '9';
const LEAGUE_KEY      = `mlb.l.${LEAGUE_ID}`;

// Validate required env vars on startup
const REQUIRED_ENV = ['YAHOO_CLIENT_ID', 'YAHOO_CLIENT_SECRET', 'YAHOO_REDIRECT_URI', 'SESSION_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`\n❌  Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
  },
}));

// Trust Railway/Render proxy so secure cookies work behind HTTPS
app.set('trust proxy', 1);

// ─── OAUTH HELPERS ────────────────────────────────────────────────────────────

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(
    `${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`
  ).toString('base64');
}

async function exchangeToken(params) {
  const res = await axios.post(
    YAHOO_TOKEN_URL,
    new URLSearchParams(params).toString(),
    {
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return res.data;
}

/**
 * Returns a valid access token, refreshing if expired/close to expiry.
 */
async function getAccessToken(req) {
  if (!req.session.tokens) {
    const err = new Error('NOT_AUTHENTICATED');
    err.code = 'NOT_AUTHENTICATED';
    throw err;
  }

  const { access_token, refresh_token, expires_at } = req.session.tokens;
  const needsRefresh = Date.now() >= expires_at - 5 * 60 * 1000;

  if (!needsRefresh) return access_token;

  try {
    const data = await exchangeToken({
      grant_type:    'refresh_token',
      redirect_uri:  process.env.YAHOO_REDIRECT_URI,
      refresh_token,
    });
    req.session.tokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token || refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  } catch (e) {
    // Refresh token is invalid — force re-auth
    req.session.destroy(() => {});
    const err = new Error('NOT_AUTHENTICATED');
    err.code = 'NOT_AUTHENTICATED';
    throw err;
  }
}

/**
 * Make an authenticated JSON request to the Yahoo Fantasy API.
 */
async function yahooGet(req, path) {
  const token = await getAccessToken(req);
  const url   = `${YAHOO_API_BASE}${path}${path.includes('?') ? '&' : '?'}format=json`;
  const res   = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });
  return res.data;
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────

// Kick off Yahoo OAuth flow
app.get('/auth/login', (_req, res) => {
  const params = new URLSearchParams({
    client_id:     process.env.YAHOO_CLIENT_ID,
    redirect_uri:  process.env.YAHOO_REDIRECT_URI,
    response_type: 'code',
    language:      'en-us',
  });
  res.redirect(`${YAHOO_AUTH_URL}?${params}`);
});

// Yahoo redirects here after user authorizes
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    console.error('OAuth error from Yahoo:', error);
    return res.redirect('/?auth_error=1');
  }

  try {
    const data = await exchangeToken({
      grant_type:   'authorization_code',
      redirect_uri: process.env.YAHOO_REDIRECT_URI,
      code,
    });

    req.session.tokens = {
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_at:    Date.now() + data.expires_in * 1000,
    };

    res.redirect('/');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.redirect('/?auth_error=1');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── API: AUTH STATUS ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    authenticated: !!req.session.tokens,
    myTeamId: MY_TEAM_ID,
    leagueId: LEAGUE_ID,
  });
});

// ─── API: LEAGUE STANDINGS ────────────────────────────────────────────────────
app.get('/api/league', async (req, res) => {
  try {
    const raw = await yahooGet(req, `/league/${LEAGUE_KEY};out=settings,standings`);
    const league = raw.fantasy_content.league;

    const settings = league[0];
    const standingsBlock = league[1]?.standings?.[0]?.teams;

    const teams = [];
    if (standingsBlock) {
      for (let i = 0; i < standingsBlock.count; i++) {
        const t = standingsBlock[i]?.team;
        if (!t) continue;

        const infoArr  = t[0];  // array of info objects
        const statsObj = t[2]?.team_standings;

        const get = key => infoArr.find(x => x[key] !== undefined)?.[key];

        teams.push({
          team_key:  get('team_key'),
          team_id:   get('team_id'),
          name:      get('name'),
          logo:      get('team_logos')?.[0]?.team_logo?.url || null,
          manager:   get('managers')?.[0]?.manager?.nickname || '',
          wins:      statsObj?.outcome_totals?.wins    || '0',
          losses:    statsObj?.outcome_totals?.losses  || '0',
          ties:      statsObj?.outcome_totals?.ties    || '0',
          pct:       statsObj?.outcome_totals?.percentage || '.000',
          rank:      statsObj?.rank || i + 1,
          streak:    statsObj?.streak?.value
                       ? `${statsObj.streak.type === 'W' ? 'W' : 'L'}${statsObj.streak.value}`
                       : '—',
          moves:     get('number_of_moves') || '0',
          waiver:    get('waiver_priority') || '—',
        });
      }
    }

    res.json({
      name:         settings.name,
      season:       settings.season,
      num_teams:    settings.num_teams,
      current_week: parseInt(settings.current_week) || 1,
      start_week:   parseInt(settings.start_week)   || 1,
      end_week:     parseInt(settings.end_week)      || 25,
      league_url:   settings.url,
      teams,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── API: SCOREBOARD ─────────────────────────────────────────────────────────
app.get('/api/scoreboard', async (req, res) => {
  try {
    const weekParam = req.query.week ? `;week=${req.query.week}` : '';
    const raw = await yahooGet(req, `/league/${LEAGUE_KEY}/scoreboard${weekParam}`);

    const league     = raw.fantasy_content.league;
    const settings   = league[0];
    const matchupsRaw = league[1]?.scoreboard?.['0']?.matchups;
    const matchups   = [];

    if (matchupsRaw) {
      for (let i = 0; i < matchupsRaw.count; i++) {
        const m = matchupsRaw[i]?.matchup;
        if (!m) continue;

        const teamsRaw = m['0']?.teams;
        const teams    = [];

        if (teamsRaw) {
          for (let j = 0; j < teamsRaw.count; j++) {
            const t     = teamsRaw[j]?.team;
            if (!t) continue;
            const info  = t[0];
            const stats = t[1];

            const get = key => info.find(x => x[key] !== undefined)?.[key];

            teams.push({
              team_key:        get('team_key'),
              team_id:         get('team_id'),
              name:            get('name'),
              logo:            get('team_logos')?.[0]?.team_logo?.url || null,
              wins:            get('team_standings')?.outcome_totals?.wins    || '0',
              losses:          get('team_standings')?.outcome_totals?.losses  || '0',
              points:          stats?.team_points?.total           || '0.00',
              projected:       stats?.team_projected_points?.total || '0.00',
              win_probability: stats?.win_probability              || null,
            });
          }
        }

        matchups.push({
          week:    m.week      || req.query.week || settings.current_week,
          status:  m.status    || 'pregame',
          is_tied: m.is_tied   || '0',
          teams,
        });
      }
    }

    res.json({
      current_week: parseInt(settings.current_week) || 1,
      week: req.query.week || settings.current_week,
      matchups,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── API: TRANSACTIONS ────────────────────────────────────────────────────────
app.get('/api/transactions', async (req, res) => {
  try {
    const raw = await yahooGet(
      req,
      `/league/${LEAGUE_KEY}/transactions;types=add,drop,trade;count=20`
    );

    const txRaw = raw.fantasy_content.league[1]?.transactions;
    const transactions = [];

    if (txRaw) {
      for (let i = 0; i < txRaw.count; i++) {
        const tx = txRaw[i]?.transaction;
        if (!tx) continue;

        const meta    = tx[0];
        const players = tx[1]?.players;
        const txObj   = {
          key:       meta.transaction_key,
          type:      meta.type,       // add, drop, trade
          status:    meta.status,     // successful, pending
          timestamp: meta.timestamp,
          players:   [],
        };

        if (players) {
          for (let p = 0; p < players.count; p++) {
            const player = players[p]?.player;
            if (!player) continue;

            const info = player[0];
            const txData = player[1]?.transaction_data;
            const td = Array.isArray(txData) ? txData[0] : txData;

            const getInfo = key => info.find(x => x[key] !== undefined)?.[key];

            txObj.players.push({
              name:      getInfo('full_name') || getInfo('name')?.full || '—',
              team:      getInfo('editorial_team_abbr') || '—',
              position:  getInfo('display_position')    || '—',
              tx_type:   td?.type,
              source:    td?.source_team_name || td?.source_type || '—',
              dest:      td?.destination_team_name || td?.destination_type || '—',
            });
          }
        }

        transactions.push(txObj);
      }
    }

    res.json({ transactions });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── API: ROSTER ──────────────────────────────────────────────────────────────
app.get('/api/teams/:teamId/roster', async (req, res) => {
  try {
    // Team key format: mlb.l.{leagueId}.t.{teamId}
    const teamKey = `mlb.l.${LEAGUE_ID}.t.${req.params.teamId}`;
    const raw     = await yahooGet(req, `/team/${teamKey}/roster/players`);

    const team       = raw.fantasy_content.team;
    const teamInfo   = team[0];
    const playersRaw = team[1]?.roster?.['0']?.players;
    const players    = [];

    if (playersRaw) {
      for (let i = 0; i < playersRaw.count; i++) {
        const p    = playersRaw[i]?.player;
        if (!p) continue;
        const info = p[0];
        const sel  = p[1]?.selected_position?.[1]?.position;

        const get = key => info.find(x => x[key] !== undefined)?.[key];

        players.push({
          name:     get('full_name') || get('name')?.full || '—',
          team:     get('editorial_team_abbr') || '—',
          position: get('display_position')    || '—',
          status:   get('status')              || 'Active',
          injury:   get('injury_note')         || null,
          selected_position: sel || '—',
        });
      }
    }

    const getTeamInfo = key => teamInfo.find(x => x[key] !== undefined)?.[key];

    res.json({
      team_name: getTeamInfo('name'),
      players,
    });
  } catch (err) {
    handleError(err, res);
  }
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
function handleError(err, res) {
  if (err.code === 'NOT_AUTHENTICATED' || err.message === 'NOT_AUTHENTICATED') {
    return res.status(401).json({ error: 'not_authenticated' });
  }

  const status  = err.response?.status  || 500;
  const message = err.response?.data?.error?.description
               || err.response?.data
               || err.message
               || 'Unknown error';

  console.error(`API Error [${status}]:`, message);
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
                              if (info.name === 'Dynasty Heroes') {
                                          leagueKeys.push({ key: info.league_key, season: info.season || gameInfo.season });
                              }
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
  
  res.status(status).json({ error: 'api_error', message: String(message) });
}

// ─── CATCH-ALL → SPA ──────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏟️  Dynasty Heroes running on port ${PORT}`);
  console.log(`   League:    ${LEAGUE_KEY}`);
  console.log(`   Callback:  ${process.env.YAHOO_REDIRECT_URI}\n`);
});
