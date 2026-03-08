# ⚾ Dynasty Heroes — Fantasy Baseball Website

Live standings, scoreboard, and transactions for the Dynasty Heroes Yahoo Fantasy Baseball league (ID# 10514).

---

## Why Deploy First?

Yahoo requires HTTPS for OAuth callback URLs — which means you can't use `http://localhost`.  
The simplest path is: **deploy to Railway → get HTTPS URL → register with Yahoo → done.**

---

## Step 1 — Push to GitHub

```bash
# In the dynasty-heroes folder:
git init
git add .
git commit -m "Initial commit"

# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/dynasty-heroes.git
git push -u origin main
```

---

## Step 2 — Deploy to Railway

1. Go to [railway.app](https://railway.app) and sign up (free)
2. Click **New Project → Deploy from GitHub repo**
3. Select your `dynasty-heroes` repo
4. Railway auto-detects Node.js and deploys — takes ~2 minutes

Once deployed, Railway gives you a URL like:
```
https://dynasty-heroes-production.up.railway.app
```

> Don't add env variables yet — you need this URL for the next step.

---

## Step 3 — Create Yahoo Developer App

1. Go to [developer.yahoo.com/apps/create/](https://developer.yahoo.com/apps/create/)
2. Fill in:
   - **Application Name**: Dynasty Heroes
   - **Description**: Fantasy baseball league website
   - **Homepage URL**: `https://dynasty-heroes-production.up.railway.app` *(your Railway URL)*
   - **Redirect URI**: `https://dynasty-heroes-production.up.railway.app/auth/callback`
   - **OAuth Client Type**: Confidential Client ✅
   - **API Permissions**: ✅ Fantasy Sports → Read
3. Click **Create App**
4. Copy your **Client ID** and **Client Secret**

---

## Step 4 — Set Environment Variables in Railway

In your Railway project dashboard → **Variables** tab, add:

| Variable | Value |
|---|---|
| `YAHOO_CLIENT_ID` | *(from Yahoo Developer app)* |
| `YAHOO_CLIENT_SECRET` | *(from Yahoo Developer app)* |
| `YAHOO_REDIRECT_URI` | `https://your-app.railway.app/auth/callback` |
| `LEAGUE_ID` | `10514` |
| `MY_TEAM_ID` | `9` |
| `SESSION_SECRET` | *(any long random string — run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)* |
| `NODE_ENV` | `production` |

Railway automatically redeploys when you save variables.

---

## Step 5 — Visit Your Site

Open your Railway URL, click **Sign in with Yahoo**, authorize, and you're live!

Share the URL with your league — anyone can sign in with their own Yahoo account.

---

## Local Development (Optional)

If you want to run locally for development, you'll need a tool like [ngrok](https://ngrok.com) to get an HTTPS URL, or use a branch on Railway.

```bash
npm install
cp .env.example .env
# Fill in .env with credentials (use ngrok URL for YAHOO_REDIRECT_URI)
npm run dev
```

---

## Project Structure

```
dynasty-heroes/
├── server/
│   └── index.js        # Express server, OAuth, Yahoo API routes
├── public/
│   ├── index.html      # App shell
│   ├── css/style.css   # Styles
│   └── js/app.js       # Frontend logic
├── .env.example        # Env variable template
├── .gitignore          # Excludes .env and node_modules
├── railway.json        # Railway deployment config
└── package.json
```

---

## API Routes

| Route | Description |
|---|---|
| `GET /auth/login` | Redirects to Yahoo OAuth |
| `GET /auth/callback` | Yahoo redirects here after auth |
| `GET /auth/logout` | Destroys session |
| `GET /api/status` | Auth check + config |
| `GET /api/league` | Standings + league info |
| `GET /api/scoreboard?week=N` | Matchups for a week |
| `GET /api/transactions` | Recent adds/drops/trades |
| `GET /api/teams/:id/roster` | Roster for a team |

---

## Troubleshooting

**Redirect URI mismatch error**
→ The `YAHOO_REDIRECT_URI` env var must *exactly* match what's in your Yahoo Developer app — same domain, same path, no trailing slash differences.

**"Not authenticated" after sign-in**
→ Double-check `YAHOO_CLIENT_ID` and `YAHOO_CLIENT_SECRET` in Railway variables.

**Empty standings / API errors**
→ Season hasn't started yet, or the Yahoo API response structure changed. Check Railway logs (`railway logs`).

**Cookies not persisting**
→ Make sure `NODE_ENV=production` is set in Railway so secure cookies are enabled.
