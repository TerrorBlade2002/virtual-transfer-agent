const express = require("express");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");

const app = express();
app.use(express.json({ limit: "25mb" }));

// ============================================================
// CONFIGURATION
// ============================================================
const DEFAULT_CSV_FILE = path.resolve(__dirname, "./contacts.csv");
const CSV_FILE_OVERRIDE = process.env.CSV_FILE ? path.resolve(process.env.CSV_FILE) : null;
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, "./data");
const CAMPAIGN_UPLOADS_DIR = path.resolve(DATA_DIR, "./uploads");
const CAMPAIGN_STATE_FILE = path.resolve(DATA_DIR, "./campaign-state.json");
const CAMPAIGN_RETENTION_DAYS = parseInt(process.env.CAMPAIGN_RETENTION_DAYS || "7", 10);
const CAMPAIGN_RETENTION_MS = CAMPAIGN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const AUTO_RESTART_ON_CAMPAIGN_LOAD = process.env.AUTO_RESTART_ON_CAMPAIGN_LOAD === "true";
const PORT = process.env.PORT || 3000;

// Your CSV column mappings
const PHONE_COLUMNS = ["PHONE1", "PHONE2", "PHONE3", "PHONE4", "PHONE5", "PHONE6"];
const DEFAULT_NAME_COLUMN = "FULL_NAME"; // → Retell {{full_name}}

// ============================================================
// DISPOSITION LABELS
// Maps function status codes → human-readable disposition labels
// These are the ONLY valid dispositions in the system.
// ============================================================
const DISPOSITION_LABELS = {
  verified:              "Full Name Verified - Right Party",
  wrong_number:          "Wrong Number",
  third_party_end:       "Third party end of conversation",
  consumer_busy_end:     "Consumer Busy - End Call",
  dnc:                   "DNC",
  customer_wants_human:  "Customer wants to talk to human",
  other:                 "Other",
  customer_disconnected: "Customer Disconnected",
};

function getDispositionLabel(status) {
  return DISPOSITION_LABELS[status] || status || "Unknown";
}

// ============================================================
// DATA STORES
// ============================================================

// 1. Campaign contacts: phone (last 10 digits) → customer info
const contacts = new Map();

// 2. Verification results: phone → { status, summary, full_name, timestamp }
//    Written by Retell custom function BEFORE end_call
//    Read by TCN after Linkback Action OK
//    Auto-expires after 5 minutes
const verificationResults = new Map();
const VERIFICATION_TTL = 5 * 60 * 1000;

// 3. Disposition log
const dispositionLog = [];

// 4. Linkback timing: phone → timestamp (ms)
//    Written by TCN Data Dip BEFORE Linkback element
//    Read by Retell inbound webhook to calculate SIP handshake time
const linkbackTimestamps = new Map();
const LINKBACK_TIMING_TTL = 2 * 60 * 1000; // 2 min expiry

// 5. Counters
let stats = {
  webhookCalls: 0,
  webhookHits: 0,
  webhookMisses: 0,
  lastCall: null,
  verificationsLogged: 0,
  verifiedCount: 0,
  wrongNumberCount: 0,
  thirdPartyEndCount: 0,
  consumerBusyEndCount: 0,
  dncCount: 0,
  customerWantsHumanCount: 0,
  otherCount: 0,
  customerDisconnectedCount: 0,
};

// 5. Active campaign state (persisted for restart/redeploy)
let campaignState = {
  campaign_id: "default-contacts",
  csv_file: DEFAULT_CSV_FILE,
  name_column: DEFAULT_NAME_COLUMN,
  uploaded_at: null,
  headers: [],
  history: [],
};

// ============================================================
// HELPERS
// ============================================================
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return digits.slice(-10);
}

function storeVerification(phone, data) {
  const normalized = normalizePhone(phone);
  verificationResults.set(normalized, { ...data, timestamp: Date.now() });
  setTimeout(() => verificationResults.delete(normalized), VERIFICATION_TTL);
}

function getVerification(phone) {
  const normalized = normalizePhone(phone);
  const result = verificationResults.get(normalized);
  if (!result) return null;
  if (Date.now() - result.timestamp > VERIFICATION_TTL) {
    verificationResults.delete(normalized);
    return null;
  }
  return result;
}

function incrementStatForStatus(status) {
  switch (status) {
    case "verified": stats.verifiedCount++; break;
    case "wrong_number": stats.wrongNumberCount++; break;
    case "third_party_end": stats.thirdPartyEndCount++; break;
    case "consumer_busy_end": stats.consumerBusyEndCount++; break;
    case "dnc": stats.dncCount++; break;
    case "customer_wants_human": stats.customerWantsHumanCount++; break;
    case "other": stats.otherCount++; break;
    case "customer_disconnected": stats.customerDisconnectedCount++; break;
  }
}

function createCampaignId(fileName = "campaign") {
  const base = String(fileName || "campaign")
    .replace(/\.csv$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${Date.now()}-${base || "campaign"}`;
}

function addCampaignHistoryEntry(entry) {
  const history = Array.isArray(campaignState.history) ? campaignState.history : [];
  history.unshift(entry);
  campaignState.history = history.slice(0, 50);
}

function pruneOldUploadedCampaigns() {
  ensureDirectories();

  const now = Date.now();
  const activePath = toAbsoluteCsvPath(campaignState.csv_file);

  let deleted = 0;
  let checked = 0;

  const files = fs.readdirSync(CAMPAIGN_UPLOADS_DIR, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile()) continue;
    checked++;

    const fullPath = path.resolve(CAMPAIGN_UPLOADS_DIR, file.name);
    if (fullPath === activePath) continue;

    const stat = fs.statSync(fullPath);
    const ageMs = now - stat.mtimeMs;

    if (ageMs > CAMPAIGN_RETENTION_MS) {
      fs.unlinkSync(fullPath);
      deleted++;
      console.log(`[CAMPAIGN CLEANUP] Deleted old upload: ${file.name}`);
    }
  }

  if (Array.isArray(campaignState.history) && campaignState.history.length) {
    campaignState.history = campaignState.history.filter((item) => {
      if (!item?.loaded_at) return true;
      const ageMs = now - new Date(item.loaded_at).getTime();
      return ageMs <= CAMPAIGN_RETENTION_MS;
    });
  }

  if (deleted > 0) {
    saveCampaignState();
  }

  return { checked, deleted };
}

function ensureDirectories() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CAMPAIGN_UPLOADS_DIR)) fs.mkdirSync(CAMPAIGN_UPLOADS_DIR, { recursive: true });
}

function toAbsoluteCsvPath(inputPath) {
  if (!inputPath) return DEFAULT_CSV_FILE;
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(__dirname, inputPath);
}

function detectNameColumn(headers = [], preferred = "") {
  const clean = headers.filter(Boolean);
  if (!clean.length) return DEFAULT_NAME_COLUMN;

  if (preferred && clean.includes(preferred)) return preferred;
  if (clean.includes(DEFAULT_NAME_COLUMN)) return DEFAULT_NAME_COLUMN;

  const normalized = clean.map((h) => ({
    original: h,
    norm: String(h).toLowerCase().replace(/[^a-z0-9]/g, ""),
  }));

  const preferredNorm = [
    "fullname",
    "full_name",
    "customername",
    "name",
    "firstname",
  ].map((v) => v.replace(/[^a-z0-9]/g, ""));

  for (const p of preferredNorm) {
    const found = normalized.find((h) => h.norm === p || h.norm.includes(p));
    if (found) return found.original;
  }

  return clean[0];
}

function saveCampaignState() {
  ensureDirectories();
  fs.writeFileSync(CAMPAIGN_STATE_FILE, JSON.stringify(campaignState, null, 2), "utf-8");
}

function loadCampaignStateFromDisk() {
  if (CSV_FILE_OVERRIDE) {
    campaignState = {
      campaign_id: "csv-file-override",
      csv_file: CSV_FILE_OVERRIDE,
      name_column: DEFAULT_NAME_COLUMN,
      uploaded_at: null,
      headers: [],
      history: [],
    };
    console.log(`[CAMPAIGN] Using CSV_FILE override: ${CSV_FILE_OVERRIDE}`);
    return;
  }

  ensureDirectories();

  if (!fs.existsSync(CAMPAIGN_STATE_FILE)) {
    campaignState = {
      campaign_id: "default-contacts",
      csv_file: DEFAULT_CSV_FILE,
      name_column: DEFAULT_NAME_COLUMN,
      uploaded_at: null,
      headers: [],
      history: [],
    };
    return;
  }

  try {
    const state = JSON.parse(fs.readFileSync(CAMPAIGN_STATE_FILE, "utf-8"));
    const filePath = toAbsoluteCsvPath(state.csv_file || DEFAULT_CSV_FILE);
    campaignState = {
      campaign_id: state.campaign_id || createCampaignId(path.basename(filePath)),
      csv_file: filePath,
      name_column: state.name_column || DEFAULT_NAME_COLUMN,
      uploaded_at: state.uploaded_at || null,
      headers: Array.isArray(state.headers) ? state.headers : [],
      history: Array.isArray(state.history) ? state.history : [],
    };

    if (!fs.existsSync(campaignState.csv_file)) {
      console.warn(`[CAMPAIGN] Saved campaign file missing, falling back to default contacts.csv`);
      campaignState = {
        campaign_id: "default-contacts",
        csv_file: DEFAULT_CSV_FILE,
        name_column: DEFAULT_NAME_COLUMN,
        uploaded_at: null,
        headers: [],
        history: campaignState.history,
      };
      saveCampaignState();
    }
  } catch (err) {
    console.error(`[CAMPAIGN] Failed reading campaign state, using default file: ${err.message}`);
    campaignState = {
      campaign_id: "default-contacts",
      csv_file: DEFAULT_CSV_FILE,
      name_column: DEFAULT_NAME_COLUMN,
      uploaded_at: null,
      headers: [],
      history: [],
    };
  }
}

function parseCsvPreview(csvContent, rowLimit = 25) {
  return new Promise((resolve, reject) => {
    const normalizedCsvContent = String(csvContent || "").replace(/^\uFEFF/, "");
    const rows = [];
    let headers = [];
    let totalRows = 0;

    const stream = require("stream");
    const readable = stream.Readable.from([normalizedCsvContent]);

    readable
      .pipe(csv())
      .on("headers", (h) => {
        headers = h || [];
      })
      .on("data", (row) => {
        totalRows++;
        if (rows.length < rowLimit) rows.push(row);
      })
      .on("end", () => resolve({ headers, rows, totalRows }))
      .on("error", reject);
  });
}

function buildContactsMapFromCsv(csvFilePath, nameColumn) {
  return new Promise((resolve, reject) => {
    const nextContacts = new Map();
    const headers = [];
    let records = 0;
    let phoneEntries = 0;

    fs.createReadStream(csvFilePath)
      .pipe(csv())
      .on("headers", (h) => {
        if (Array.isArray(h)) headers.push(...h);
      })
      .on("data", (row) => {
        records++;
        const chosenName = (row[nameColumn] || row[DEFAULT_NAME_COLUMN] || "").trim();

        for (const col of PHONE_COLUMNS) {
          const rawPhone = (row[col] || "").trim();
          if (!rawPhone) continue;

          const phone = normalizePhone(rawPhone);
          if (phone.length !== 10) continue;

          nextContacts.set(phone, {
            full_name: chosenName,
            raw_record: {
              full_name_original: (row[DEFAULT_NAME_COLUMN] || "").trim(),
              account: (row["ACCOUNT"] || "").trim(),
              masteracct: (row["MASTERACCT"] || "").trim(),
              cltrefno: (row["CLTREFNO"] || "").trim(),
            },
          });
          phoneEntries++;
        }
      })
      .on("end", () => {
        resolve({ nextContacts, records, phoneEntries, headers });
      })
      .on("error", reject);
  });
}

// ============================================================
// LOAD CONTACTS FROM ACTIVE CAMPAIGN CSV
// ============================================================
async function loadContacts() {
  loadCampaignStateFromDisk();

  const filePath = toAbsoluteCsvPath(campaignState.csv_file);
  const selectedNameColumn = campaignState.name_column || DEFAULT_NAME_COLUMN;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Campaign CSV not found: ${filePath}`);
  }

  const { nextContacts, records, phoneEntries, headers } = await buildContactsMapFromCsv(filePath, selectedNameColumn);

  contacts.clear();
  for (const [k, v] of nextContacts.entries()) {
    contacts.set(k, v);
  }

  campaignState = {
    ...campaignState,
    campaign_id: campaignState.campaign_id || createCampaignId(path.basename(filePath)),
    csv_file: filePath,
    name_column: detectNameColumn(headers, selectedNameColumn),
    headers,
  };

  if (!CSV_FILE_OVERRIDE) {
    saveCampaignState();
  }

  if (!CSV_FILE_OVERRIDE) {
    pruneOldUploadedCampaigns();
  }

  console.log(`[CAMPAIGN] Loaded ${records} records → ${phoneEntries} phone entries`);
  console.log(`[CAMPAIGN] Active campaign ID: ${campaignState.campaign_id}`);
  console.log(`[CAMPAIGN] Active file: ${campaignState.csv_file}`);
  console.log(`[CAMPAIGN] Name column: ${campaignState.name_column}`);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getCampaignPortalHtml() {
  const activeCampaignId = campaignState.campaign_id || "default-contacts";
  const activeFileName = path.basename(campaignState.csv_file || DEFAULT_CSV_FILE);
  const activeNameColumn = campaignState.name_column || DEFAULT_NAME_COLUMN;
  const activeHeaders = JSON.stringify(campaignState.headers || []);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Campaign Loader</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
      --accent: #1d4ed8;
      --accent-2: #dbeafe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .wrap {
      max-width: 1100px;
      margin: 32px auto;
      padding: 0 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(15, 23, 42, 0.05);
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 1.4rem;
      font-weight: 650;
      letter-spacing: 0.01em;
    }
    .muted { color: var(--muted); font-size: 0.95rem; }
    .row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
      margin-top: 12px;
    }
    input[type="file"], select {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
      background: #fff;
      color: var(--text);
      min-width: 260px;
      font-size: 0.95rem;
    }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 10px;
      padding: 10px 16px;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 600;
    }
    button.secondary {
      background: var(--accent-2);
      color: #1e3a8a;
      border-color: #bfdbfe;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .pill {
      display: inline-block;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.82rem;
      color: var(--muted);
      margin-right: 8px;
    }
    .status {
      margin-top: 12px;
      font-size: 0.92rem;
      color: #0f5132;
      background: #ecfdf3;
      border: 1px solid #bbf7d0;
      padding: 10px 12px;
      border-radius: 10px;
      display: none;
      white-space: pre-wrap;
    }
    .error {
      color: #7f1d1d;
      background: #fef2f2;
      border-color: #fecaca;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 0.9rem;
    }
    th, td {
      text-align: left;
      padding: 9px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
      max-width: 280px;
      overflow-wrap: anywhere;
    }
    th {
      background: #f8fafc;
      position: sticky;
      top: 0;
      z-index: 1;
      font-weight: 600;
    }
    .table-wrap {
      max-height: 440px;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Campaign Upload Portal</h1>
      <div class="muted">Upload a campaign CSV, preview headers and rows, choose the name header for Retell inbound webhook, then load it live.</div>
      <div class="row" style="margin-top:10px;">
        <span class="pill">Campaign ID: ${escapeHtml(activeCampaignId)}</span>
        <span class="pill">Default fallback: ${escapeHtml(DEFAULT_NAME_COLUMN)}</span>
        <span class="pill">Active file: ${escapeHtml(activeFileName)}</span>
        <span class="pill">Active name header: ${escapeHtml(activeNameColumn)}</span>
      </div>
    </div>

    <div class="card">
      <div class="row">
        <input id="fileInput" type="file" accept=".csv,text/csv" />
        <button id="previewBtn" class="secondary">Preview CSV</button>
      </div>
      <div class="row">
        <label for="nameHeader" class="muted">Header used for Retell <strong>{{full_name}}</strong>:</label>
        <select id="nameHeader"></select>
        <button id="loadBtn" disabled>Load Campaign</button>
      </div>
      <div id="status" class="status"></div>
    </div>

    <div class="card">
      <div class="muted">Preview (first rows)</div>
      <div id="previewWrap" class="table-wrap">
        <table id="previewTable">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const activeHeaders = ${activeHeaders};
    const defaultName = ${JSON.stringify(DEFAULT_NAME_COLUMN)};
    const state = {
      csvContent: "",
      fileName: "",
      headers: activeHeaders,
      selectedHeader: ${JSON.stringify(activeNameColumn)},
    };

    const fileInput = document.getElementById("fileInput");
    const previewBtn = document.getElementById("previewBtn");
    const loadBtn = document.getElementById("loadBtn");
    const nameHeader = document.getElementById("nameHeader");
    const statusEl = document.getElementById("status");
    const thead = document.querySelector("#previewTable thead");
    const tbody = document.querySelector("#previewTable tbody");

    function showStatus(text, isError = false) {
      statusEl.style.display = "block";
      statusEl.className = "status" + (isError ? " error" : "");
      statusEl.textContent = text;
    }

    function setHeaderOptions(headers, selected) {
      nameHeader.innerHTML = "";
      if (!headers || !headers.length) {
        const opt = document.createElement("option");
        opt.value = defaultName;
        opt.textContent = defaultName;
        nameHeader.appendChild(opt);
        return;
      }
      headers.forEach((h) => {
        const opt = document.createElement("option");
        opt.value = h;
        opt.textContent = h;
        if (h === selected) opt.selected = true;
        nameHeader.appendChild(opt);
      });
    }

    function renderPreview(headers, rows) {
      thead.innerHTML = "";
      tbody.innerHTML = "";

      const trHead = document.createElement("tr");
      headers.forEach((h) => {
        const th = document.createElement("th");
        th.textContent = h;
        trHead.appendChild(th);
      });
      thead.appendChild(trHead);

      rows.forEach((row) => {
        const tr = document.createElement("tr");
        headers.forEach((h) => {
          const td = document.createElement("td");
          td.textContent = row[h] || "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    async function readFileText(file) {
      return await file.text();
    }

    previewBtn.addEventListener("click", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showStatus("Select a CSV file first.", true);
        return;
      }

      try {
        previewBtn.disabled = true;
        const csvContent = await readFileText(file);
        const res = await fetch("/campaign/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csvContent, fileName: file.name }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Preview failed");

        state.csvContent = csvContent;
        state.fileName = file.name;
        state.headers = data.headers || [];
        state.selectedHeader = data.suggestedNameColumn || defaultName;

        setHeaderOptions(state.headers, state.selectedHeader);
        renderPreview(data.headers || [], data.previewRows || []);
        loadBtn.disabled = false;
        showStatus("Preview ready. Rows detected: " + data.totalRows + ". Suggested name header: " + state.selectedHeader);
      } catch (err) {
        showStatus(err.message || "Preview failed.", true);
      } finally {
        previewBtn.disabled = false;
      }
    });

    loadBtn.addEventListener("click", async () => {
      if (!state.csvContent) {
        showStatus("Preview a CSV first.", true);
        return;
      }

      const selectedHeader = nameHeader.value || defaultName;
      try {
        loadBtn.disabled = true;
        const res = await fetch("/campaign/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            csvContent: state.csvContent,
            fileName: state.fileName,
            nameColumn: selectedHeader,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Load failed");

        showStatus(
          "Campaign loaded.\\n" +
          "Campaign ID: " + data.campaignId + "\\n" +
          "Records: " + data.records + "\\n" +
          "Phone entries indexed: " + data.phoneEntries + "\\n" +
          "Name header: " + data.nameColumn + "\\n" +
          "Active file: " + data.activeFile
        );
      } catch (err) {
        showStatus(err.message || "Load failed.", true);
      } finally {
        loadBtn.disabled = false;
      }
    });

    setHeaderOptions(state.headers, state.selectedHeader);
  </script>
</body>
</html>`;
}

app.get("/campaign-portal", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getCampaignPortalHtml());
});

app.get("/campaign-state", (req, res) => {
  res.json({
    campaignId: campaignState.campaign_id || "default-contacts",
    activeFile: campaignState.csv_file,
    activeFileName: path.basename(campaignState.csv_file || DEFAULT_CSV_FILE),
    nameColumn: campaignState.name_column || DEFAULT_NAME_COLUMN,
    headers: campaignState.headers || [],
    contactsLoaded: contacts.size,
    uploadedAt: campaignState.uploaded_at,
    retentionDays: CAMPAIGN_RETENTION_DAYS,
    recentCampaigns: (campaignState.history || []).slice(0, 10),
  });
});

app.post("/campaign/preview", async (req, res) => {
  try {
    const csvContent = req.body?.csvContent;
    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({ error: "csvContent is required" });
    }

    const { headers, rows, totalRows } = await parseCsvPreview(csvContent, 30);
    if (!headers.length) {
      return res.status(400).json({ error: "CSV headers not found" });
    }

    const suggestedNameColumn = detectNameColumn(headers, campaignState.name_column);
    return res.json({
      fileName: req.body?.fileName || "uploaded.csv",
      headers,
      previewRows: rows,
      totalRows,
      suggestedNameColumn,
    });
  } catch (err) {
    console.error(`[CAMPAIGN PREVIEW] Error: ${err.message}`);
    return res.status(400).json({ error: `Invalid CSV: ${err.message}` });
  }
});

app.post("/campaign/load", async (req, res) => {
  try {
    const csvContent = String(req.body?.csvContent || "").replace(/^\uFEFF/, "");
    const fileNameRaw = req.body?.fileName || "campaign.csv";
    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({ error: "csvContent is required" });
    }

    ensureDirectories();
    const safeName = path.basename(fileNameRaw).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const stampedName = `${Date.now()}-${safeName}`;
    const targetPath = path.resolve(CAMPAIGN_UPLOADS_DIR, stampedName);
    fs.writeFileSync(targetPath, csvContent, "utf-8");
    const campaignId = createCampaignId(safeName);

    const preview = await parseCsvPreview(csvContent, 1);
    const requestedNameColumn = req.body?.nameColumn || "";
    const selectedNameColumn = detectNameColumn(preview.headers, requestedNameColumn);

    const { nextContacts, records, phoneEntries, headers } = await buildContactsMapFromCsv(targetPath, selectedNameColumn);

    contacts.clear();
    for (const [k, v] of nextContacts.entries()) {
      contacts.set(k, v);
    }

    campaignState = {
      campaign_id: campaignId,
      csv_file: targetPath,
      name_column: selectedNameColumn,
      uploaded_at: new Date().toISOString(),
      headers,
      history: campaignState.history || [],
    };

    addCampaignHistoryEntry({
      campaign_id: campaignId,
      file_name: path.basename(targetPath),
      name_column: selectedNameColumn,
      records,
      phone_entries: phoneEntries,
      loaded_at: campaignState.uploaded_at,
    });

    if (!CSV_FILE_OVERRIDE) {
      saveCampaignState();
      pruneOldUploadedCampaigns();
    }

    console.log(`[CAMPAIGN] Loaded new upload: ${safeName}`);
    console.log(`[CAMPAIGN] Campaign ID: ${campaignId}`);
    console.log(`[CAMPAIGN] Records: ${records}, Phone entries: ${phoneEntries}`);
    console.log(`[CAMPAIGN] Name column for webhook: ${selectedNameColumn}`);

    const responseBody = {
      success: true,
      message: "Campaign loaded",
      campaignId,
      records,
      phoneEntries,
      nameColumn: selectedNameColumn,
      activeFile: path.basename(targetPath),
      persisted: !CSV_FILE_OVERRIDE,
      note: "The server is already using this campaign. On restart/redeploy, saved campaign state will be loaded automatically.",
      restartScheduled: AUTO_RESTART_ON_CAMPAIGN_LOAD,
    };

    res.json(responseBody);

    if (AUTO_RESTART_ON_CAMPAIGN_LOAD) {
      console.warn(`[CAMPAIGN] AUTO_RESTART_ON_CAMPAIGN_LOAD=true, restarting process to refresh instance.`);
      setTimeout(() => process.exit(1), 600);
    }

    return;
  } catch (err) {
    console.error(`[CAMPAIGN LOAD] Error: ${err.message}`);
    return res.status(400).json({ error: `Failed to load campaign: ${err.message}` });
  }
});

// ============================================================
// ROUTE 0: TCN — LINKBACK TIMER (fire-and-forget)
//
// TCN Data Dip hits this BEFORE the Linkback element.
// Records timestamp so we can calculate SIP handshake time
// when the Retell webhook fires for the same phone.
// ============================================================
app.get("/linkback-start", (req, res) => {
  const phone = normalizePhone(req.query.phone || "");
  if (phone.length === 10) {
    linkbackTimestamps.set(phone, Date.now());
    setTimeout(() => linkbackTimestamps.delete(phone), LINKBACK_TIMING_TTL);
    console.log(`[LINKBACK START] ${phone}: TCN about to dial Retell`);
  }
  res.json({ ok: true });
});

// ============================================================
// ROUTE 1: RETELL INBOUND WEBHOOK
// ============================================================
app.post("/retell-webhook", (req, res) => {
  stats.webhookCalls++;
  stats.lastCall = new Date().toISOString();

  const fromNumber = req.body?.call_inbound?.from_number || "";
  const normalizedFrom = normalizePhone(fromNumber);

  console.log(`[WEBHOOK] ${fromNumber} → ${normalizedFrom}`);

  const contact = contacts.get(normalizedFrom);

  if (contact) {
    stats.webhookHits++;

    // Calculate SIP handshake time if linkback-start was recorded
    const linkbackStart = linkbackTimestamps.get(normalizedFrom);
    if (linkbackStart) {
      const sipHandshakeMs = Date.now() - linkbackStart;
      console.log(`[SIP TIMING] ${normalizedFrom}: ${sipHandshakeMs}ms (TCN Linkback → Retell webhook)`);
      linkbackTimestamps.delete(normalizedFrom);
    }

    console.log(`  ✓ ${contact.full_name}`);

    return res.json({
      call_inbound: {
        dynamic_variables: {
          full_name: contact.full_name,
        },
        metadata: {
          source: "tcn_linkback",
          lookup_status: "found",
          account: contact.raw_record.account,
          cltrefno: contact.raw_record.cltrefno,
        },
      },
    });
  }

  stats.webhookMisses++;

  // Still capture SIP timing even if contact not found
  const linkbackStartMiss = linkbackTimestamps.get(normalizedFrom);
  if (linkbackStartMiss) {
    const sipHandshakeMs = Date.now() - linkbackStartMiss;
    console.log(`[SIP TIMING] ${normalizedFrom}: ${sipHandshakeMs}ms (TCN Linkback → Retell webhook) [MISS]`);
    linkbackTimestamps.delete(normalizedFrom);
  }

  console.log(`  ✗ NOT FOUND`);

  return res.json({
    call_inbound: {
      dynamic_variables: {
        full_name: "",
      },
      metadata: {
        source: "tcn_linkback",
        lookup_status: "not_found",
      },
    },
  });
});

// ============================================================
// ROUTE 2: RETELL CUSTOM FUNCTION — LOG VERIFICATION RESULT
//
// Valid statuses:
//   verified, wrong_number, third_party_end,
//   consumer_busy_end, dnc, customer_wants_human, other
// ============================================================
app.post("/log-verification", (req, res) => {
  console.log(`[VERIFICATION] Full payload:`, JSON.stringify(req.body, null, 2));

  const args = req.body?.args || req.body || {};
  const { status, summary, full_name } = args;

  const phone = args.phone
    || req.body?.call?.from_number
    || req.body?.call?.to_number
    || req.body?.from_number
    || "";
  const normalized = normalizePhone(phone);

  if (!status) {
    console.log(`[VERIFICATION] ERROR — no status provided`);
    return res.json({ result: "error: missing status" });
  }

  const phoneKey = (normalized && normalized.length === 10) ? normalized : "unknown";

  if (phoneKey !== "unknown") {
    storeVerification(phoneKey, {
      status,
      summary: summary || "",
      full_name: full_name || "",
    });
  }

  stats.verificationsLogged++;
  incrementStatForStatus(status);

  dispositionLog.push({
    phone: phoneKey,
    status,
    disposition: getDispositionLabel(status),
    summary: summary || "",
    full_name: full_name || "",
    source: "log_verification",
    timestamp: new Date().toISOString(),
  });

  console.log(`[VERIFICATION] ${phoneKey}: ${getDispositionLabel(status)} — ${summary || ""}`);

  // Race condition fix: if call_ended arrived first and created a
  // "customer_disconnected" fallback, overwrite it with real status.
  const fallbackEntry = dispositionLog.slice().reverse().find(
    (d) => d.phone === phoneKey && d.status === "customer_disconnected" && d.source === "retell_call_ended"
  );
  if (fallbackEntry) {
    fallbackEntry.status = status;
    fallbackEntry.disposition = getDispositionLabel(status);
    fallbackEntry.summary = summary || fallbackEntry.summary;
    fallbackEntry.full_name = full_name || fallbackEntry.full_name;
    fallbackEntry.source = "log_verification_late";
    stats.customerDisconnectedCount--;
    console.log(`[VERIFICATION] Overwrote Customer Disconnected fallback for ${phoneKey} → ${getDispositionLabel(status)}`);
  }

  return res.json({ result: `Logged: ${getDispositionLabel(status)}` });
});

// ============================================================
// ROUTE 3: TCN — GET VERIFICATION STATUS
//
// TCN Data Dip Key: whisper
//
// HTTP STATUS CODE STRATEGY (drives TCN branching):
//   200 → verified / customer_wants_human → Action OK → Hunt Group (agent gets call)
//   409 → wrong_number / third_party_end / consumer_busy_end / dnc / other → Action Error → Hangup (no agent)
//   404 → no result / customer_disconnected → Action Error → Hangup (no agent)
// ============================================================

// Statuses that should reach an agent
const AGENT_STATUSES = new Set(["verified", "customer_wants_human"]);

app.get("/verification-status", (req, res) => {
  const phone = req.query.phone || "";
  const normalized = normalizePhone(phone);
  const result = getVerification(normalized);

  if (!result) {
    console.log(`[TCN LOOKUP] ${normalized}: NOT FOUND → HTTP 404`);
    return res.status(404).json({
      found: false,
      status: "unknown",
      disposition: "Unknown",
      whisper: "VTA — No verification data.",
    });
  }

  let whisper = "";

  switch (result.status) {
    case "verified":
      whisper = `VERIFIED — ${result.full_name || "Customer"} confirmed identity.`;
      break;
    case "wrong_number":
      whisper = `WRONG NUMBER — Not the right contact.`;
      break;
    case "third_party_end":
      whisper = `THIRD PARTY END — Consumer unavailable.`;
      break;
    case "consumer_busy_end":
      whisper = `CONSUMER BUSY END — Consumer is busy; call back later.`;
      break;
    case "dnc":
      whisper = `DNC — Customer requested Do Not Call.`;
      break;
    case "customer_wants_human":
      whisper = `HUMAN REQUESTED — Customer wants live agent. Verify manually.`;
      break;
    case "other":
      whisper = `OTHER — ${result.summary || "See disposition log."}`;
      break;
    case "customer_disconnected":
      whisper = `CUSTOMER DISCONNECTED — Hung up before verification.`;
      break;
    default:
      whisper = `VTA processed. Status: ${result.status}`;
  }

  const shouldReachAgent = AGENT_STATUSES.has(result.status);
  const httpCode = shouldReachAgent ? 200 : 409;

  console.log(`[TCN LOOKUP] ${normalized}: ${getDispositionLabel(result.status)} → HTTP ${httpCode}`);
  return res.status(httpCode).json({
    found: true,
    status: result.status,
    disposition: getDispositionLabel(result.status),
    whisper,
    summary: result.summary,
    full_name: result.full_name,
  });
});

// ============================================================
// ROUTE 4: RETELL CALL-ENDED WEBHOOK
//
// KEY LOGIC: If call_ended fires and NO log_verification exists
// for this phone → customer hung up early → "customer_disconnected"
// ============================================================
app.post("/retell-call-ended", (req, res) => {
  const { event, call } = req.body || {};

  if (event === "call_ended" && call) {
    const phone = normalizePhone(call.from_number || call.to_number || "");
    const callId = call.call_id || "";
    const durationMs = call.duration_ms || 0;
    const disconnectReason = call.disconnection_reason || "";

    console.log(`[CALL ENDED] ${phone} | ${durationMs}ms | ${disconnectReason}`);

    const hasVerification = phone.length === 10 && getVerification(phone);
    const hasDispositionEntry = dispositionLog.some(
      (d) => d.phone === phone
        && d.source === "log_verification"
        && (Date.now() - new Date(d.timestamp).getTime()) < VERIFICATION_TTL
    );

    if (hasVerification || hasDispositionEntry) {
      // Normal: log_verification already fired. Enrich with call metadata.
      const existing = dispositionLog.slice().reverse().find(
        (d) => d.phone === phone && d.source === "log_verification"
      );
      if (existing && !existing.call_id) {
        existing.call_id = callId;
        existing.duration_ms = durationMs;
        existing.disconnect_reason = disconnectReason;
      }
      console.log(`[CALL ENDED] ${phone}: Verification exists — enriched with metadata`);
    } else {
      // FALLBACK: Customer hung up before log_verification.
      const contactInfo = phone.length === 10 ? contacts.get(phone) : null;

      dispositionLog.push({
        phone: phone || "unknown",
        call_id: callId,
        status: "customer_disconnected",
        disposition: getDispositionLabel("customer_disconnected"),
        summary: `Customer disconnected. Reason: ${disconnectReason}`,
        full_name: contactInfo ? contactInfo.full_name : "",
        duration_ms: durationMs,
        disconnect_reason: disconnectReason,
        source: "retell_call_ended",
        timestamp: new Date().toISOString(),
      });

      if (phone.length === 10) {
        storeVerification(phone, {
          status: "customer_disconnected",
          summary: `Customer hung up. Reason: ${disconnectReason}`,
          full_name: contactInfo ? contactInfo.full_name : "",
        });
      }

      stats.customerDisconnectedCount++;
      console.log(`[CALL ENDED] ${phone}: ⚠ No verification — logged as Customer Disconnected`);
    }
  }

  if (event === "call_analyzed" && call) {
    const phone = normalizePhone(call.from_number || call.to_number || "");
    const callId = call.call_id || "";

    const existing = dispositionLog.slice().reverse().find(
      (d) => d.call_id === callId || (d.phone === phone && d.status && !d.call_id)
    );

    if (existing) {
      existing.analysis = call.call_analysis;
      existing.transcript = call.transcript;
      if (!existing.call_id) existing.call_id = callId;

      // Try to upgrade customer_disconnected with call analysis
      if (existing.status === "customer_disconnected" && call.call_analysis) {
        const cs = (call.call_analysis.call_summary || "").toLowerCase();
        const callSuccessful = call.call_analysis.call_successful;

        // Check verified FIRST — if Retell says call was successful and
        // agent disconnected (not customer), this was a completed verification
        if (
          callSuccessful === true
          || cs.includes("confirmed identity")
          || cs.includes("confirmed name")
          || cs.includes("verified")
          || cs.includes("transfer to a representative")
          || cs.includes("transfer to our representative")
          || (cs.includes("confirmed") && cs.includes("transfer"))
        ) {
          existing.status = "verified";
          existing.disposition = getDispositionLabel("verified");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.verifiedCount++;
          // Also update verificationResults so TCN Data Dip reads correct status
          if (existing.phone && existing.phone.length === 10) {
            storeVerification(existing.phone, {
              status: "verified",
              summary: existing.summary,
              full_name: existing.full_name,
            });
          }
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → Full Name Verified - Right Party`);
        } else if (cs.includes("wrong number") || cs.includes("wrong person")) {
          existing.status = "wrong_number";
          existing.disposition = getDispositionLabel("wrong_number");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.wrongNumberCount++;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → Wrong Number`);
        } else if (
          cs.includes("call back later")
          || cs.includes("callback later")
          || cs.includes("consumer was busy")
          || cs.includes("customer was busy")
          || cs.includes("consumer is busy")
          || cs.includes("customer is busy")
          || cs.includes("busy right now")
          || (cs.includes("busy") && cs.includes("call back"))
          || cs.includes("at work")
          || cs.includes("driving")
          || cs.includes("doctor appointment")
        ) {
          existing.status = "consumer_busy_end";
          existing.disposition = getDispositionLabel("consumer_busy_end");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.consumerBusyEndCount++;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → Consumer Busy - End Call`);
        } else if (cs.includes("third party") || cs.includes("not available") || cs.includes("not home")) {
          existing.status = "third_party_end";
          existing.disposition = getDispositionLabel("third_party_end");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.thirdPartyEndCount++;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → Third party end`);
        } else if (cs.includes("do not call") || cs.includes("stop calling") || cs.includes("remove my number")) {
          existing.status = "dnc";
          existing.disposition = getDispositionLabel("dnc");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.dncCount++;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → DNC`);
        } else {
          existing.summary = call.call_analysis.call_summary || existing.summary;
          console.log(`[CALL ANALYZED] ${phone}: Enriched Customer Disconnected with analysis`);
        }
      } else {
        console.log(`[CALL ANALYZED] ${phone}: Enriched with transcript`);
      }
    } else {
      dispositionLog.push({
        phone,
        call_id: callId,
        analysis: call.call_analysis,
        transcript: call.transcript,
        source: "retell_call_analyzed",
        timestamp: new Date().toISOString(),
      });
      console.log(`[CALL ANALYZED] ${phone}: No matching entry — created standalone`);
    }
  }

  res.status(204).send();
});

// ============================================================
// ROUTE 5: DISPOSITIONS
// ============================================================
app.get("/dispositions", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const statusFilter = req.query.status || null;

  let results = dispositionLog.filter((d) => d.status).slice().reverse();
  if (statusFilter) results = results.filter((d) => d.status === statusFilter);

  res.json({
    total: results.length,
    showing: Math.min(results.length, limit),
    dispositions: results.slice(0, limit),
  });
});

app.get("/dispositions/csv", (req, res) => {
  const withStatus = dispositionLog.filter((d) => d.status);

  const header = "timestamp,phone,disposition,status,summary,full_name,call_id,duration_ms,disconnect_reason,source\n";
  const rows = withStatus.map((d) =>
    [
      d.timestamp || "",
      d.phone || "",
      getDispositionLabel(d.status),
      d.status || "",
      (d.summary || "").replace(/,/g, ";").replace(/\n/g, " "),
      (d.full_name || "").replace(/,/g, ";"),
      d.call_id || "",
      d.duration_ms || "",
      d.disconnect_reason || "",
      d.source || "",
    ].join(",")
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=vta-dispositions-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(header + rows);
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    contacts_loaded: contacts.size,
    active_campaign_id: campaignState.campaign_id,
    active_campaign_file: campaignState.csv_file,
    active_campaign_name_column: campaignState.name_column,
    campaign_retention_days: CAMPAIGN_RETENTION_DAYS,
    activeVerifications: verificationResults.size,
    totalDispositions: dispositionLog.filter((d) => d.status).length,
    ...stats,
    uptime: Math.floor(process.uptime()),
  });
});

// ============================================================
// STARTUP
// ============================================================
loadContacts()
  .then(() => {
    if (!CSV_FILE_OVERRIDE) {
      const cleanupResult = pruneOldUploadedCampaigns();
      console.log(`[CAMPAIGN CLEANUP] Startup check complete. Checked: ${cleanupResult.checked}, Deleted: ${cleanupResult.deleted}`);
      setInterval(() => {
        const result = pruneOldUploadedCampaigns();
        if (result.deleted > 0) {
          console.log(`[CAMPAIGN CLEANUP] Interval run. Checked: ${result.checked}, Deleted: ${result.deleted}`);
        }
      }, 6 * 60 * 60 * 1000);
    }

    app.listen(PORT, () => {
      console.log(`\nVTA Webhook running on port ${PORT}`);
      console.log(`Phone entries indexed: ${contacts.size}`);
      console.log(`Active campaign ID: ${campaignState.campaign_id}`);
      console.log(`Active campaign file: ${campaignState.csv_file}`);
      console.log(`Active name column: ${campaignState.name_column}`);
      console.log(`Campaign retention: ${CAMPAIGN_RETENTION_DAYS} days`);
      console.log(`Auto restart on campaign load: ${AUTO_RESTART_ON_CAMPAIGN_LOAD}`);
      console.log(`\nValid dispositions:`);
      for (const [code, label] of Object.entries(DISPOSITION_LABELS)) {
        console.log(`  ${code} → ${label}`);
      }
      console.log(`\nEndpoints:`);
      console.log(`  GET  /campaign-portal         → Upload + preview + load campaign CSV`);
      console.log(`  GET  /campaign-state          → Active campaign metadata`);
      console.log(`  POST /campaign/preview        → Preview uploaded CSV content`);
      console.log(`  POST /campaign/load           → Load uploaded CSV into memory`);
      console.log(`  POST /retell-webhook        → Retell inbound (dynamic vars)`);
      console.log(`  POST /log-verification      → Retell custom fn (verification result)`);
      console.log(`  GET  /verification-status    → TCN reads verification result`);
      console.log(`  POST /retell-call-ended      → Retell call ended/analyzed webhook`);
      console.log(`  GET  /dispositions           → View dispositions (JSON)`);
      console.log(`  GET  /dispositions/csv       → Download dispositions (CSV)`);
      console.log(`  GET  /linkback-start          → TCN pre-linkback timer ping`);
      console.log(`  GET  /health                 → Health check`);
    });
  })
  .catch((err) => {
    console.error("Failed to load contacts:", err);
    process.exit(1);
  });