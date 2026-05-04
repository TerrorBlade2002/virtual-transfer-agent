# Retell VTA Inbound Webhook

Webhook server for the Virtual Transfer Agent flow.

- Keeps all existing Retell + TCN endpoints working.
- Loads contacts from CSV into memory for fast webhook lookup.
- Adds a simple campaign upload portal to preview CSV data, pick the name header, and load it live.

## How It Works

```
TCN Linkback → Retell Phone Number → Retell fires Inbound Webhook → This server
                                                                        ↓
                                                              Looks up customer by phone
                                                                        ↓
                                                              Returns { full_name, ssn_last_two_digit }
                                                                        ↓
                                                              Retell agent says "Hi, am I speaking with Jane Smith?"
```

## Setup Instructions

### 1. Prepare your default contacts.csv

Default file is `./contacts.csv` (project root). This remains the fallback campaign.

Expected campaign format:

`FULL_NAME,FIRSTNAME,MASTERACCT,ACCOUNT,CLTREFNO,PHONE1,PHONE2,PHONE3,PHONE4,PHONE5,PHONE6`

Every non-empty phone column (`PHONE1`-`PHONE6`) is normalized to last 10 digits and indexed.

### 2. Deploy to Railway (recommended for quick setup)

1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Railway auto-detects Node.js and runs `npm start`
4. Your webhook URL will be: `https://your-app.railway.app/retell-webhook`

### 3. Alternative: Deploy to Render

1. Push to GitHub
2. Go to https://render.com → New Web Service → Connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Your webhook URL will be: `https://your-app.onrender.com/retell-webhook`

### 4. Configure Retell Dashboard

1. Log into https://app.retellai.com
2. Go to **Phone Numbers** in the left sidebar
3. Click on your VTA phone number (6457771038)
4. Find the **Inbound Webhook URL** field
5. Paste your deployed URL: `https://your-app.railway.app/retell-webhook`
6. Save

### 5. Test

1. Check server health: `curl https://your-app.railway.app/health`
2. Run a test broadcast from TCN with one contact
3. Check server logs to confirm the webhook fired and returned correct data
4. Verify Retell agent used the correct name in its greeting

## Campaign Upload Portal (new)

Open:

- `/campaign-portal`

Flow:

1. Upload a CSV file.
2. Click **Preview CSV** to view headers and sample rows.
3. Select the header to use for Retell `{{full_name}}`.
4. Click **Load Campaign**.

What happens:

- Uploaded file is saved under `./data/uploads`.
- Contacts are reloaded in-memory immediately.
- Active campaign state is persisted in `./data/campaign-state.json`.
- Every loaded campaign gets a unique `campaignId` for observability.
- Uploaded files older than 7 days are auto-deleted (except active campaign file).
- On restart/redeploy, the server reloads the last selected campaign automatically.
- If no uploaded campaign exists, it uses `contacts.csv`.

Additional endpoints:

- `GET /campaign-state`
- `POST /campaign/preview`
- `POST /campaign/load`
- `GET /dispositions-portal`
- `GET /dispositions/availability`
- `GET /dispositions`
- `GET /dispositions/csv`

`GET /campaign-state` includes:

- current `campaignId`
- active file + header
- recent campaign history
- retention policy

## Railway deployment behavior

- Loading a campaign already switches webhook data live immediately (no manual redeploy needed).
- Rebuild/redeploy from Railway Source Repo is triggered by a new commit to `main`.
- Optional: set `AUTO_RESTART_ON_CAMPAIGN_LOAD=true` to auto-restart the running instance after load (restart, not new build).
- Keep `Healthcheck Path` as `/health`.

## Environment Variables (optional)

- `PORT` — Server port (default: 3000)
- `CSV_FILE` — Force a specific CSV path (overrides portal-selected campaign)
- `DATA_DIR` — Directory for campaign state/uploads (use Railway volume mount path)
- `CAMPAIGN_RETENTION_DAYS` — Upload retention (default: 7)
- `DISPOSITION_RETENTION_DAYS` — Disposition retention window (default: 7)
- `REPORT_TIMEZONE` — Date filter timezone for disposition downloads (default: `America/New_York`)
- `CAMPAIGN_ADMIN_TOKEN` — Optional token required for disposition JSON/CSV download endpoints
- `AUTO_RESTART_ON_CAMPAIGN_LOAD` — `true` to auto-restart process after campaign load
