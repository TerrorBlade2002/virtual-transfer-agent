# Retell VTA Inbound Webhook

Webhook server that receives inbound calls from Retell AI, looks up customer data from a CSV file, and returns dynamic variables (full_name, ssn_last_two_digit) so the Voice AI agent can personalize its greeting.

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

### 1. Prepare your contacts.csv

Export your TCN campaign list and save it as `contacts.csv` with these columns:
- `phone` — the customer's phone number (any format, digits are extracted automatically)
- `full_name` — customer's full name
- `ssn_last_two` — last two digits of SSN

If your CSV has different column names, update the `CSV_COLUMNS` mapping in `server.js`.

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

## Updating Contact Data

Replace `contacts.csv` with your new campaign export and restart the server. The CSV is loaded into memory on startup for fast lookups.

## Environment Variables (optional)

- `PORT` — Server port (default: 3000)
- `CSV_FILE` — Path to contacts CSV (default: ./contacts.csv)
