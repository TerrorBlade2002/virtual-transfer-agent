const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const csv = require("csv-parser");
const XLSX = require("xlsx");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;
const UPLOAD_KEY = process.env.UPLOAD_KEY || "changeme123";
const DATA_DIR = process.env.DATA_DIR || "./data";

// CSV column mappings
const PHONE_COLUMNS = [
  "PHONE1",
  "PHONE2",
  "PHONE3",
  "PHONE4",
  "PHONE5",
  "PHONE6",
];
const NAME_COLUMN = "FIRSTNAME"; // → Retell {{full_name}}
const ACCOUNT_COLUMN = "MASTERACCT"; // → Retell {{ssn_last_two_digit}}

// ============================================================
// DATA STORES
// ============================================================

// 1. Campaign contacts: phone (last 10 digits) → customer info
const contacts = new Map();

// 2. Verification results: phone → { status, summary, full_name, timestamp }
//    Written by Retell custom function BEFORE end_call
//    Read by TCN Custom Integration JS AFTER Linkback Action OK
//    Auto-expires after 5 minutes
const verificationResults = new Map();
const VERIFICATION_TTL = 5 * 60 * 1000;

// 3. Disposition log: all call outcomes for reporting
const dispositionLog = [];

// 4. Status counters
let dataStatus = {
  loaded: false,
  records: 0,
  phoneEntries: 0,
  filename: null,
  uploadedAt: null,
  webhookCalls: 0,
  webhookHits: 0,
  webhookMisses: 0,
  lastCall: null,
  verificationsLogged: 0,
  verifiedCount: 0,
  failedCount: 0,
  humanRequestedCount: 0,
  thirdPartyCount: 0,
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
  verificationResults.set(normalized, {
    ...data,
    timestamp: Date.now(),
  });
  // Auto-cleanup after TTL
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

// ============================================================
// CSV / EXCEL PARSING
// ============================================================
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function parseExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

async function loadFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return parseCSV(filePath);
  if (ext === ".xlsx" || ext === ".xls") return parseExcel(filePath);
  throw new Error(`Unsupported file type: ${ext}`);
}

function indexContacts(rows) {
  contacts.clear();
  let phoneEntries = 0;

  for (const row of rows) {
    const name = String(row[NAME_COLUMN] || "").trim();
    const account = String(row[ACCOUNT_COLUMN] || "").trim();

    for (const col of PHONE_COLUMNS) {
      const rawPhone = String(row[col] || "").trim();
      if (rawPhone) {
        const phone = normalizePhone(rawPhone);
        if (phone.length === 10) {
          contacts.set(phone, {
            full_name: name,
            ssn_last_two_digit: account,
            raw: {
              full_name_original: String(row["FULL_NAME"] || "").trim(),
              account: String(row["ACCOUNT"] || "").trim(),
              cltrefno: String(row["CLTREFNO"] || "").trim(),
            },
          });
          phoneEntries++;
        }
      }
    }
  }

  return { records: rows.length, phoneEntries };
}

// ============================================================
// FILE UPLOAD SETUP
// ============================================================
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const upload = multer({
  dest: DATA_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".csv", ".xlsx", ".xls"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only .csv, .xlsx, .xls files allowed"));
    }
  },
});

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function requireAuth(req, res, next) {
  const key =
    req.body?.key || req.query?.key || req.headers["x-upload-key"];
  if (key === UPLOAD_KEY) return next();
  return res.status(401).json({ error: "Invalid upload key" });
}

// ============================================================
// ROUTE 1: RETELL INBOUND WEBHOOK
// Retell calls this when a call arrives on the VTA phone number.
// Returns dynamic_variables so Retell agent knows who it's talking to.
// NO AUTH — Retell needs open access.
// ============================================================
app.post("/retell-webhook", (req, res) => {
  dataStatus.webhookCalls++;
  dataStatus.lastCall = new Date().toISOString();

  const fromNumber = req.body?.call_inbound?.from_number || "";
  const normalized = normalizePhone(fromNumber);

  console.log(`[INBOUND WEBHOOK] ${fromNumber} → ${normalized}`);

  const contact = contacts.get(normalized);

  if (contact) {
    dataStatus.webhookHits++;
    console.log(
      `  ✓ ${contact.full_name} | MASTERACCT: ${contact.ssn_last_two_digit}`
    );

    return res.json({
      call_inbound: {
        dynamic_variables: {
          full_name: contact.full_name,
          ssn_last_two_digit: contact.ssn_last_two_digit,
        },
        metadata: {
          source: "tcn_linkback",
          lookup_status: "found",
          account: contact.raw.account,
          cltrefno: contact.raw.cltrefno,
        },
      },
    });
  }

  dataStatus.webhookMisses++;
  console.log(`  ✗ NOT FOUND`);

  return res.json({
    call_inbound: {
      dynamic_variables: {
        full_name: "",
        ssn_last_two_digit: "",
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
// Called by Retell's Custom Function DURING the call, BEFORE end_call.
// Retell agent triggers this after verifying (or failing to verify).
// Stores the result so TCN can read it after Linkback completes.
//
// Retell sends: { args: { phone, status, summary, full_name } }
// Valid statuses:
//   "verified"             — customer confirmed identity
//   "customer_wants_human" — customer refused AI, wants human directly
//   "failed"               — wrong person, couldn't verify
//   "third_party"          — someone else answered the phone
//
// NO AUTH — Retell custom functions need open access.
// ============================================================
app.post("/log-verification", (req, res) => {
  // Retell custom functions send data inside args object
  const args = req.body?.args || req.body || {};
  const { phone, status, summary, full_name } = args;

  const normalized = normalizePhone(phone || "");

  if (!normalized || normalized.length !== 10 || !status) {
    console.log(
      `[VERIFICATION] ERROR — missing phone or status. Got: phone=${phone}, status=${status}`
    );
    return res.json({ result: "error: missing phone or status" });
  }

  // Store for TCN to read
  storeVerification(normalized, {
    status,
    summary: summary || "",
    full_name: full_name || "",
  });

  // Update counters
  dataStatus.verificationsLogged++;
  if (status === "verified") dataStatus.verifiedCount++;
  else if (status === "failed") dataStatus.failedCount++;
  else if (status === "customer_wants_human")
    dataStatus.humanRequestedCount++;
  else if (status === "third_party") dataStatus.thirdPartyCount++;

  // Log for reporting
  dispositionLog.push({
    phone: normalized,
    status,
    summary: summary || "",
    full_name: full_name || "",
    source: "retell_verification",
    timestamp: new Date().toISOString(),
  });

  console.log(
    `[VERIFICATION] ${normalized}: ${status} — ${summary || "no summary"}`
  );

  // Retell expects { result: "string" } from custom functions
  return res.json({ result: `Logged: ${status}` });
});

// ============================================================
// ROUTE 3: TCN INTEGRATION — GET VERIFICATION STATUS
//
// Called by TCN Custom Integration JavaScript AFTER Linkback Action OK.
// TCN script hits this to find out what happened during the Retell call.
// Returns status + dynamic whisper text.
//
// TCN JavaScript would call:
//   GET /verification-status?phone=9043230987
//
// NO AUTH — TCN's JS environment may not support auth headers.
// Protected by: 5-minute TTL (results expire), phone-based lookup only.
// ============================================================
app.get("/verification-status", (req, res) => {
  const phone = req.query.phone || "";
  const normalized = normalizePhone(phone);

  const result = getVerification(normalized);

  if (result) {
    // Build dynamic whisper text based on verification outcome
    let whisper = "";
    let disposition = "";

    switch (result.status) {
      case "verified":
        whisper = `Verified call. Customer ${result.full_name || "unknown"} confirmed identity.`;
        disposition = "VTA_VERIFIED";
        break;
      case "customer_wants_human":
        whisper = `Customer requested live agent. Standard verification needed.`;
        disposition = "VTA_HUMAN_REQUESTED";
        break;
      case "failed":
        whisper = `Verification failed. Could not confirm identity.`;
        disposition = "VTA_FAILED";
        break;
      case "third_party":
        whisper = `Third party answered. Not the account holder.`;
        disposition = "VTA_THIRD_PARTY";
        break;
      default:
        whisper = `VTA processed. Status: ${result.status}`;
        disposition = "VTA_UNKNOWN";
    }

    console.log(`[TCN LOOKUP] ${normalized}: ${result.status} → ${disposition}`);

    return res.json({
      found: true,
      status: result.status,
      disposition,
      summary: result.summary,
      full_name: result.full_name,
      whisper,
    });
  }

  console.log(`[TCN LOOKUP] ${normalized}: NOT FOUND (expired or never logged)`);

  return res.json({
    found: false,
    status: "unknown",
    disposition: "VTA_NO_RESULT",
    summary: "No verification result found — may have expired",
    whisper: "VTA call. Verification status unknown. Verify manually.",
  });
});

// ============================================================
// ROUTE 4: RETELL CALL-ENDED / CALL-ANALYZED WEBHOOK
//
// Set this as your Retell Account-Level Webhook.
// Captures full transcripts and post-call analysis for every call.
// Used for disposition reporting and sync with TCN.
//
// NO AUTH — Retell webhooks need open access.
// Verify with x-retell-signature header in production.
// ============================================================
app.post("/retell-call-ended", (req, res) => {
  const { event, call } = req.body || {};

  if (event === "call_ended" && call) {
    const phone = normalizePhone(
      call.from_number || call.to_number || ""
    );

    const entry = {
      phone,
      call_id: call.call_id,
      direction: call.direction,
      duration_ms: call.duration_ms,
      disconnect_reason: call.disconnection_reason,
      source: "retell_call_ended",
      timestamp: new Date().toISOString(),
    };

    dispositionLog.push(entry);
    console.log(
      `[CALL ENDED] ${phone} | ${call.duration_ms}ms | ${call.disconnection_reason}`
    );
  }

  if (event === "call_analyzed" && call) {
    const phone = normalizePhone(
      call.from_number || call.to_number || ""
    );
    console.log(`[CALL ANALYZED] ${phone}`);

    // Find the matching call_ended entry and attach analysis
    const existing = dispositionLog
      .slice()
      .reverse()
      .find((d) => d.call_id === call.call_id);

    if (existing) {
      existing.analysis = call.call_analysis;
      existing.transcript = call.transcript;
    } else {
      // No matching call_ended — log standalone
      dispositionLog.push({
        phone,
        call_id: call.call_id,
        analysis: call.call_analysis,
        transcript: call.transcript,
        source: "retell_call_analyzed",
        timestamp: new Date().toISOString(),
      });
    }
  }

  res.status(204).send();
});

// ============================================================
// ROUTE 5: DISPOSITIONS REPORT
// View and export all logged call outcomes.
// Auth required.
// ============================================================

// JSON view (most recent first)
app.get("/dispositions", requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const statusFilter = req.query.status || null;

  let results = dispositionLog.slice().reverse();
  if (statusFilter) {
    results = results.filter((d) => d.status === statusFilter);
  }
  results = results.slice(0, limit);

  res.json({
    total: dispositionLog.length,
    showing: results.length,
    filter: statusFilter,
    dispositions: results,
  });
});

// CSV export
app.get("/dispositions/csv", requireAuth, (req, res) => {
  const header =
    "timestamp,phone,status,disposition,summary,full_name,call_id,duration_ms,disconnect_reason,source\n";
  const rows = dispositionLog
    .map(
      (d) =>
        `${d.timestamp || ""},${d.phone || ""},${d.status || ""},${d.disposition || ""},${(d.summary || "").replace(/,/g, ";")},${(d.full_name || "").replace(/,/g, ";")},${d.call_id || ""},${d.duration_ms || ""},${d.disconnect_reason || ""},${d.source || ""}`
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=vta-dispositions-${new Date().toISOString().slice(0, 10)}.csv`
  );
  res.send(header + rows);
});

// ============================================================
// ROUTE 6: UPLOAD CAMPAIGN FILE
// Auth required.
// ============================================================
app.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();
    const savedPath = path.join(DATA_DIR, `contacts${ext}`);

    // Move uploaded file to permanent location
    fs.renameSync(req.file.path, savedPath);

    // Parse and index
    const rows = await loadFromFile(savedPath);
    const { records, phoneEntries } = indexContacts(rows);

    dataStatus.loaded = true;
    dataStatus.records = records;
    dataStatus.phoneEntries = phoneEntries;
    dataStatus.filename = originalName;
    dataStatus.uploadedAt = new Date().toISOString();

    // Reset webhook counters on new upload (verification counters persist)
    dataStatus.webhookCalls = 0;
    dataStatus.webhookHits = 0;
    dataStatus.webhookMisses = 0;

    console.log(
      `[UPLOAD] ${originalName}: ${records} records → ${phoneEntries} phone entries`
    );

    return res.json({
      success: true,
      filename: originalName,
      records,
      phoneEntries,
      message: `Loaded ${records} records with ${phoneEntries} phone entries`,
    });
  } catch (err) {
    console.error("[UPLOAD ERROR]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 7: TEST LOOKUP
// Returns both contact data AND verification status for a phone number.
// Auth required.
// ============================================================
app.get("/lookup", requireAuth, (req, res) => {
  const phone = req.query.phone || "";
  const normalized = normalizePhone(phone);
  const contact = contacts.get(normalized);
  const verification = getVerification(normalized);

  return res.json({
    query: phone,
    normalized,
    contact_found: !!contact,
    contact_data: contact || null,
    verification_found: !!verification,
    verification_data: verification || null,
  });
});

// ============================================================
// ROUTE 8: HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ...dataStatus,
    activeVerifications: verificationResults.size,
    totalDispositions: dispositionLog.length,
    uptime: Math.floor(process.uptime()),
  });
});

// ============================================================
// UPLOAD PORTAL HTML
// ============================================================
const UPLOAD_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VTA Campaign Manager</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:1.5rem}
    .container{max-width:740px;margin:0 auto}
    h1{font-size:1.4rem;color:#f8fafc;margin-bottom:0.3rem}
    .sub{color:#94a3b8;font-size:0.85rem;margin-bottom:1.5rem}
    .card{background:#1e293b;border-radius:12px;padding:1.5rem;margin-bottom:1.2rem;border:1px solid #334155}
    .card h2{font-size:0.95rem;color:#f1f5f9;margin-bottom:1rem;letter-spacing:0.02em}
    label{display:block;font-size:0.82rem;color:#94a3b8;margin-bottom:0.35rem}
    input[type="text"],input[type="password"],input[type="file"]{
      width:100%;padding:0.55rem 0.75rem;background:#0f172a;border:1px solid #475569;
      border-radius:8px;color:#f8fafc;font-size:0.88rem;margin-bottom:0.9rem}
    input:focus{outline:none;border-color:#3b82f6}
    button{background:#3b82f6;color:#fff;border:none;padding:0.65rem 1.4rem;border-radius:8px;
      font-size:0.88rem;cursor:pointer;width:100%;font-weight:600;transition:background 0.2s}
    button:hover{background:#2563eb}
    button:disabled{background:#475569;cursor:not-allowed}
    .g{display:grid;gap:0.7rem}
    .g3{grid-template-columns:repeat(3,1fr)}
    .g4{grid-template-columns:repeat(4,1fr)}
    .st{background:#0f172a;padding:0.7rem;border-radius:8px;text-align:center}
    .st .n{font-size:1.2rem;font-weight:700;color:#3b82f6}
    .st .l{font-size:0.68rem;color:#94a3b8;margin-top:0.15rem;text-transform:uppercase;letter-spacing:0.04em}
    .row{display:flex;justify-content:space-between;padding:0.35rem 0;border-bottom:1px solid #334155;font-size:0.83rem}
    .row:last-child{border:none}
    .row .k{color:#94a3b8}
    .row .v{color:#f1f5f9;font-weight:500}
    .msg{padding:0.7rem;border-radius:8px;margin-top:0.8rem;font-size:0.83rem;display:none}
    .msg.ok{display:block;background:#064e3b;border:1px solid #059669;color:#6ee7b7}
    .msg.err{display:block;background:#450a0a;border:1px solid #dc2626;color:#fca5a5}
    .pre{background:#0f172a;padding:0.7rem;border-radius:8px;margin-top:0.5rem;
      font-family:'SF Mono',Consolas,monospace;font-size:0.78rem;white-space:pre-wrap;display:none;
      max-height:300px;overflow-y:auto;color:#cbd5e1}
    .sec{font-size:0.75rem;color:#64748b;margin:0.8rem 0 0.4rem;text-transform:uppercase;letter-spacing:0.06em}
    .gr{color:#22c55e}.rd{color:#ef4444}.yl{color:#eab308}.cy{color:#06b6d4}
    .pills{display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap}
    .pill{padding:0.3rem 0.8rem;border-radius:20px;font-size:0.75rem;cursor:pointer;
      border:1px solid #475569;color:#94a3b8;transition:all 0.2s}
    .pill:hover,.pill.active{border-color:#3b82f6;color:#3b82f6;background:#1e3a5f}
  </style>
</head>
<body>
<div class="container">
  <h1>VTA Campaign Manager</h1>
  <p class="sub">Upload campaigns &middot; Monitor verifications &middot; Track dispositions &middot; Export reports</p>

  <!-- STATS -->
  <div class="card">
    <h2>Live Dashboard</h2>
    <div class="sec">Campaign Data</div>
    <div class="g g3">
      <div class="st"><div class="n" id="sRec">-</div><div class="l">Records</div></div>
      <div class="st"><div class="n" id="sPh">-</div><div class="l">Phones</div></div>
      <div class="st"><div class="n" id="sHit">-</div><div class="l">Webhook Hits</div></div>
    </div>
    <div class="sec">Verification Results</div>
    <div class="g g4">
      <div class="st"><div class="n gr" id="sV">-</div><div class="l">Verified</div></div>
      <div class="st"><div class="n rd" id="sF">-</div><div class="l">Failed</div></div>
      <div class="st"><div class="n yl" id="sH">-</div><div class="l">Human Req</div></div>
      <div class="st"><div class="n cy" id="sT">-</div><div class="l">3rd Party</div></div>
    </div>
    <div style="margin-top:0.8rem">
      <div class="row"><span class="k">File</span><span class="v" id="iFile">None</span></div>
      <div class="row"><span class="k">Uploaded</span><span class="v" id="iTime">-</span></div>
      <div class="row"><span class="k">Last Call</span><span class="v" id="iLast">-</span></div>
      <div class="row"><span class="k">Active Verifications (in memory)</span><span class="v" id="iAV">-</span></div>
      <div class="row"><span class="k">Total Dispositions Logged</span><span class="v" id="iDisp">-</span></div>
    </div>
  </div>

  <!-- UPLOAD -->
  <div class="card">
    <h2>Upload Campaign List</h2>
    <label>Upload Key</label>
    <input type="password" id="key" placeholder="Enter upload key" />
    <label>File (.csv, .xlsx, .xls)</label>
    <input type="file" id="file" accept=".csv,.xlsx,.xls" />
    <button id="ubtn" onclick="doUpload()">Upload &amp; Activate</button>
    <div class="msg" id="umsg"></div>
  </div>

  <!-- LOOKUP -->
  <div class="card">
    <h2>Test Lookup</h2>
    <label>Phone Number</label>
    <input type="text" id="tph" placeholder="e.g. 9043230987" />
    <button onclick="doLookup()">Look Up Contact + Verification</button>
    <div class="pre" id="tres"></div>
  </div>

  <!-- DISPOSITIONS -->
  <div class="card">
    <h2>Dispositions</h2>
    <div class="pills">
      <span class="pill active" onclick="filterDisp(null,this)">All</span>
      <span class="pill" onclick="filterDisp('verified',this)">Verified</span>
      <span class="pill" onclick="filterDisp('failed',this)">Failed</span>
      <span class="pill" onclick="filterDisp('customer_wants_human',this)">Human Req</span>
      <span class="pill" onclick="filterDisp('third_party',this)">3rd Party</span>
    </div>
    <div class="pre" id="dlist" style="display:block;min-height:60px;max-height:400px">Loading...</div>
    <div style="margin-top:0.8rem">
      <button onclick="exportCSV()">Export All as CSV</button>
    </div>
  </div>

  <!-- ENDPOINT REFERENCE -->
  <div class="card" style="opacity:0.7">
    <h2>Endpoint Reference</h2>
    <div class="row"><span class="k">POST /retell-webhook</span><span class="v">Retell inbound (dynamic vars)</span></div>
    <div class="row"><span class="k">POST /log-verification</span><span class="v">Retell custom fn (log result)</span></div>
    <div class="row"><span class="k">GET /verification-status?phone=X</span><span class="v">TCN reads result</span></div>
    <div class="row"><span class="k">POST /retell-call-ended</span><span class="v">Retell webhook (transcripts)</span></div>
    <div class="row"><span class="k">GET /dispositions</span><span class="v">View dispositions (auth)</span></div>
    <div class="row"><span class="k">GET /dispositions/csv</span><span class="v">Export CSV (auth)</span></div>
  </div>
</div>

<script>
const K=()=>document.getElementById('key').value;

async function poll(){
  try{
    const r=await fetch('/health');const d=await r.json();
    document.getElementById('sRec').textContent=d.records||0;
    document.getElementById('sPh').textContent=d.phoneEntries||0;
    document.getElementById('sHit').textContent=d.webhookHits||0;
    document.getElementById('sV').textContent=d.verifiedCount||0;
    document.getElementById('sF').textContent=d.failedCount||0;
    document.getElementById('sH').textContent=d.humanRequestedCount||0;
    document.getElementById('sT').textContent=d.thirdPartyCount||0;
    document.getElementById('iFile').textContent=d.filename||'None';
    document.getElementById('iTime').textContent=d.uploadedAt?new Date(d.uploadedAt).toLocaleString():'-';
    document.getElementById('iLast').textContent=d.lastCall?new Date(d.lastCall).toLocaleString():'-';
    document.getElementById('iAV').textContent=d.activeVerifications||0;
    document.getElementById('iDisp').textContent=d.totalDispositions||0;
  }catch(e){console.error(e)}
}
poll();setInterval(poll,8000);

async function doUpload(){
  const key=K(),fi=document.getElementById('file'),msg=document.getElementById('umsg'),btn=document.getElementById('ubtn');
  if(!key){sm(msg,'Enter upload key','err');return}
  if(!fi.files[0]){sm(msg,'Select a file','err');return}
  btn.disabled=true;btn.textContent='Uploading...';
  const fd=new FormData();fd.append('file',fi.files[0]);fd.append('key',key);
  try{
    const r=await fetch('/upload',{method:'POST',body:fd});const d=await r.json();
    if(d.success){sm(msg,d.records+' records → '+d.phoneEntries+' phone entries loaded','ok');poll()}
    else sm(msg,d.error||'Failed','err');
  }catch(e){sm(msg,e.message,'err')}
  btn.disabled=false;btn.textContent='Upload & Activate';
}

async function doLookup(){
  const ph=document.getElementById('tph').value,el=document.getElementById('tres');
  if(!ph)return;
  try{
    const r=await fetch('/lookup?phone='+encodeURIComponent(ph)+'&key='+encodeURIComponent(K()));
    const d=await r.json();el.style.display='block';el.textContent=JSON.stringify(d,null,2);
  }catch(e){el.style.display='block';el.textContent='Error: '+e.message}
}

let currentFilter=null;
async function filterDisp(status,pill){
  document.querySelectorAll('.pill').forEach(p=>p.classList.remove('active'));
  if(pill)pill.classList.add('active');
  currentFilter=status;
  const el=document.getElementById('dlist');
  try{
    let url='/dispositions?key='+encodeURIComponent(K())+'&limit=50';
    if(status)url+='&status='+status;
    const r=await fetch(url);
    if(r.status===401){el.textContent='Enter upload key above first';return}
    const d=await r.json();
    if(d.dispositions.length===0){el.textContent='No dispositions yet';return}
    el.textContent=d.dispositions.map(x=>
      (x.timestamp||'').slice(11,19)+' | '+x.phone+' | '+(x.status||x.disconnect_reason||'-')+' | '+(x.summary||x.source||'')
    ).join('\\n');
  }catch(e){el.textContent='Error: '+e.message}
}
setTimeout(()=>filterDisp(null,document.querySelector('.pill.active')),1500);

function exportCSV(){
  const key=K();
  if(!key){alert('Enter upload key first');return}
  window.location.href='/dispositions/csv?key='+encodeURIComponent(key);
}

function sm(el,t,c){el.className='msg '+c;el.textContent=t}
</script>
</body>
</html>`;

app.get("/", (req, res) => res.send(UPLOAD_PAGE_HTML));

// ============================================================
// STARTUP — load contacts from root ./contacts.csv OR ./data/ directory
// ============================================================
async function startup() {
  // Check locations in priority order:
  // 1. Root directory (original deployment: ./contacts.csv)
  // 2. Data directory (uploaded via portal: ./data/contacts.csv)
  const searchPaths = [
    // Root directory files (your original contacts.csv lives here)
    "./contacts.csv",
    "./contacts.xlsx",
    "./contacts.xls",
    // Data directory files (created by upload portal)
    path.join(DATA_DIR, "contacts.csv"),
    path.join(DATA_DIR, "contacts.xlsx"),
    path.join(DATA_DIR, "contacts.xls"),
  ];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const rows = await loadFromFile(filePath);
        const { records, phoneEntries } = indexContacts(rows);
        dataStatus.loaded = true;
        dataStatus.records = records;
        dataStatus.phoneEntries = phoneEntries;
        dataStatus.filename = path.basename(filePath);
        dataStatus.uploadedAt = new Date(
          fs.statSync(filePath).mtime
        ).toISOString();
        console.log(
          `[STARTUP] Loaded ${records} records (${phoneEntries} phones) from ${filePath}`
        );
        break;
      } catch (err) {
        console.error(
          `[STARTUP] Failed to load ${filePath}:`,
          err.message
        );
      }
    }
  }

  app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  VTA Webhook Server v3.0`);
    console.log(`  Port: ${PORT}`);
    console.log(`========================================`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /retell-webhook         → Retell inbound (dynamic vars)`);
    console.log(`  POST /log-verification       → Retell custom fn (log result)`);
    console.log(`  GET  /verification-status     → TCN reads verification result`);
    console.log(`  POST /retell-call-ended       → Retell call ended/analyzed webhook`);
    console.log(`  GET  /dispositions            → View dispositions (auth)`);
    console.log(`  GET  /dispositions/csv        → Export CSV (auth)`);
    console.log(`  POST /upload                  → Upload campaign file (auth)`);
    console.log(`  GET  /lookup                  → Test phone lookup (auth)`);
    console.log(`  GET  /health                  → Health check`);
    console.log(`  GET  /                        → Dashboard\n`);
    console.log(`Contacts loaded: ${contacts.size}`);
    console.log(`========================================\n`);
  });
}

startup().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
