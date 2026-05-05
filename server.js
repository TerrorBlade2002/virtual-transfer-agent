// Load local .env for dev. On Railway, no .env file exists so dotenv silently
// no-ops and the env vars injected by the Railway UI are used instead.
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const csv = require("csv-parser");
const multer = require("multer");

const app = express();
app.use(express.json({ limit: "25mb" }));

// Multer instance for multipart CSV uploads. In-memory (25 MB cap) so we can
// write the file atomically to its date-keyed destination ourselves.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — matches express.json limit
});

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
const DISPOSITION_LOG_FILE = path.resolve(DATA_DIR, "./dispositions-log.json");
const CAMPAIGN_RETENTION_DAYS = parseInt(process.env.CAMPAIGN_RETENTION_DAYS || "7", 10);
const CAMPAIGN_RETENTION_MS = CAMPAIGN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const DISPOSITION_RETENTION_DAYS = parseInt(process.env.DISPOSITION_RETENTION_DAYS || "7", 10);
const DISPOSITION_RETENTION_MS = DISPOSITION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || "America/New_York";
const CAMPAIGN_ADMIN_TOKEN = process.env.CAMPAIGN_ADMIN_TOKEN || process.env.ADMIN_TOKEN || "";
const AUTO_RESTART_ON_CAMPAIGN_LOAD = process.env.AUTO_RESTART_ON_CAMPAIGN_LOAD === "true";
const PORT = process.env.PORT || 3000;

// Your CSV column mappings
const PHONE_COLUMNS = ["PHONE1", "PHONE2", "PHONE3", "PHONE4", "PHONE5", "PHONE6"];
const DEFAULT_NAME_COLUMN = "FULL_NAME"; // → Retell {{full_name}}

// ============================================================
// AUTH CONFIG
//
// Two-tier bearer auth for the NEW (date-keyed) endpoints.
// Existing endpoints (/campaign/load, /dispositions, /dispositions/csv with
// no date param, etc.) stay unauthenticated for backward compatibility.
//
//   CAMPAIGN_ADMIN_TOKEN  (env)  → single admin token; grants full admin access
//   data/user-tokens.json        → list of hashed user tokens (upload + download)
//
// Clients pass either header:
//   Authorization: Bearer <token>
//   X-Campaign-Token: <token>
// ============================================================
const ADMIN_TOKEN = process.env.CAMPAIGN_ADMIN_TOKEN || "";
const USER_TOKENS_FILE = path.resolve(DATA_DIR, "./user-tokens.json");
const CAMPAIGN_TIMEZONE = "America/New_York"; // EST / EDT — DST-safe

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
//
// campaignsByDate (NEW): dateKey "YYYY-MM-DD" → metadata for that day's upload.
// One file per date; re-uploading for the same date overwrites the previous one.
// Entries >7 days old are pruned. Default contacts.csv is the fallback when
// today has no upload.
let campaignState = {
  campaign_id: "default-contacts",
  csv_file: DEFAULT_CSV_FILE,
  name_column: DEFAULT_NAME_COLUMN,
  uploaded_at: null,
  headers: [],
  history: [],
  campaignsByDate: {},
};

// Tracks which date-keyed campaign is currently live in the `contacts` Map.
// Used to avoid re-loading the same file repeatedly and to detect rollover.
let activeCampaignDate = null;

// ============================================================
// HELPERS
// ============================================================
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return digits.slice(-10);
}

function totalContactEntries() {
  let n = 0;
  for (const arr of contacts.values()) n += arr.length;
  return n;
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

function getTimestampMs(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getDateKeyInTimeZone(value, timeZone = REPORT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const mapped = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${mapped.year}-${mapped.month}-${mapped.day}`;
}

function parseDateParam(rawValue, fieldName) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return null;
  const value = String(rawValue).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${fieldName} must be in YYYY-MM-DD format`);
  }
  return value;
}

function saveDispositionLogToDisk() {
  ensureDirectories();
  fs.writeFileSync(DISPOSITION_LOG_FILE, JSON.stringify(dispositionLog, null, 2), "utf-8");
}

function pruneExpiredDispositions({ persist = true } = {}) {
  ensureDirectories();

  const cutoffMs = Date.now() - DISPOSITION_RETENTION_MS;
  const before = dispositionLog.length;
  const kept = dispositionLog.filter((entry) => {
    const timestampMs = getTimestampMs(entry?.timestamp);
    if (timestampMs === null) return true;
    return timestampMs >= cutoffMs;
  });

  dispositionLog.splice(0, dispositionLog.length, ...kept);
  const deleted = before - dispositionLog.length;

  if (persist && deleted > 0) {
    saveDispositionLogToDisk();
  }

  return { checked: before, deleted };
}

function loadDispositionLogFromDisk() {
  ensureDirectories();

  if (!fs.existsSync(DISPOSITION_LOG_FILE)) {
    dispositionLog.length = 0;
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DISPOSITION_LOG_FILE, "utf-8"));
    const records = Array.isArray(parsed) ? parsed : [];
    dispositionLog.splice(0, dispositionLog.length, ...records);

    const cleanupResult = pruneExpiredDispositions({ persist: false });
    if (cleanupResult.deleted > 0) {
      saveDispositionLogToDisk();
    }

    console.log(
      `[DISPOSITIONS] Loaded ${dispositionLog.length} records from disk `
      + `(deleted ${cleanupResult.deleted} expired)`
    );
  } catch (err) {
    console.error(`[DISPOSITIONS] Failed reading persisted log: ${err.message}`);
    dispositionLog.length = 0;
  }
}

function appendDispositionEntry(entry) {
  dispositionLog.push(entry);
  pruneExpiredDispositions({ persist: false });
  saveDispositionLogToDisk();
}

function persistDispositionUpdates() {
  pruneExpiredDispositions({ persist: false });
  saveDispositionLogToDisk();
}

function getDispositionFilters(query = {}) {
  const status = query.status ? String(query.status).trim() : null;
  const exactDate = parseDateParam(query.date, "date");
  const fromDate = parseDateParam(query.from, "from");
  const toDate = parseDateParam(query.to, "to");

  if (exactDate && (fromDate || toDate)) {
    throw new Error("Use either date or from/to filters, not both");
  }

  const startDate = exactDate || fromDate;
  const endDate = exactDate || toDate;
  const latestAllowedDate = getDateKeyInTimeZone(new Date(), REPORT_TIMEZONE);
  const earliestAllowed = new Date(`${latestAllowedDate}T00:00:00Z`);
  earliestAllowed.setUTCDate(earliestAllowed.getUTCDate() - (DISPOSITION_RETENTION_DAYS - 1));
  const earliestAllowedDate = earliestAllowed.toISOString().slice(0, 10);

  if (startDate && endDate && startDate > endDate) {
    throw new Error("from must be earlier than or equal to to");
  }

  if ((startDate && startDate < earliestAllowedDate) || (endDate && endDate < earliestAllowedDate)) {
    throw new Error(`Dates older than ${earliestAllowedDate} are outside retention`);
  }

  if ((startDate && startDate > latestAllowedDate) || (endDate && endDate > latestAllowedDate)) {
    throw new Error(`Dates later than ${latestAllowedDate} are not allowed`);
  }

  if (startDate && endDate) {
    const diffDays = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / (24 * 60 * 60 * 1000)) + 1;
    if (diffDays > DISPOSITION_RETENTION_DAYS) {
      throw new Error(`Date range cannot exceed ${DISPOSITION_RETENTION_DAYS} days`);
    }
  }

  return {
    status,
    timeZone: REPORT_TIMEZONE,
    date: exactDate,
    from: startDate,
    to: endDate,
  };
}

function filterDispositionEntries(entries, filters = {}) {
  return entries.filter((entry) => {
    if (!entry?.status) return false;

    if (filters.status && entry.status !== filters.status) {
      return false;
    }

    if (filters.from || filters.to) {
      const dateKey = getDateKeyInTimeZone(entry.timestamp, filters.timeZone || REPORT_TIMEZONE);
      if (!dateKey) return false;
      if (filters.from && dateKey < filters.from) return false;
      if (filters.to && dateKey > filters.to) return false;
    }

    return true;
  });
}

function buildDispositionCsvFileName(filters = {}) {
  if (filters.from && filters.to && filters.from !== filters.to) {
    return `vta-dispositions-${filters.from}-to-${filters.to}.csv`;
  }

  const suffix = filters.from || getDateKeyInTimeZone(new Date(), REPORT_TIMEZONE);
  return `vta-dispositions-${suffix}.csv`;
}

function getRecentDispositionAvailability() {
  const todayKey = getDateKeyInTimeZone(new Date(), REPORT_TIMEZONE);
  const counts = new Map();

  for (const entry of dispositionLog) {
    if (!entry?.status) continue;
    const dateKey = getDateKeyInTimeZone(entry.timestamp, REPORT_TIMEZONE);
    if (!dateKey) continue;
    counts.set(dateKey, (counts.get(dateKey) || 0) + 1);
  }

  return Array.from({ length: DISPOSITION_RETENTION_DAYS }, (_, offset) => {
    const date = new Date(`${todayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - offset);
    const dateKey = date.toISOString().slice(0, 10);
    return {
      date: dateKey,
      count: counts.get(dateKey) || 0,
      available: (counts.get(dateKey) || 0) > 0,
      isToday: offset === 0,
    };
  });
}

function readCampaignAdminToken(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }

  return String(
    req.headers["x-campaign-admin-token"]
      || req.query.token
      || req.query.admin_token
      || ""
  ).trim();
}

function isCampaignAdminAuthorized(req) {
  if (!CAMPAIGN_ADMIN_TOKEN) return true;
  return readCampaignAdminToken(req) === CAMPAIGN_ADMIN_TOKEN;
}

function requireCampaignAdminToken(req, res) {
  if (isCampaignAdminAuthorized(req)) return true;

  res.status(401).json({
    error: "Unauthorized",
    message: "Valid campaign admin token required",
  });
  return false;
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

  // Also prune date-keyed entries: any YYYY-MM-DD older than retention window
  // (using Eastern-time "today" as the reference so the behaviour is stable
  // across UTC/local boundaries).
  let dateKeyedDeleted = 0;
  if (campaignState.campaignsByDate && typeof campaignState.campaignsByDate === "object") {
    const today = getEasternDateString();
    const next = {};
    for (const [dateKey, meta] of Object.entries(campaignState.campaignsByDate)) {
      if (!isValidDateString(dateKey)) continue; // drop malformed keys
      const ageDays = daysBetweenEasternDates(today, dateKey);
      if (ageDays > CAMPAIGN_RETENTION_DAYS) {
        const filePath = csvAbsolutePathForDate(dateKey);
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            dateKeyedDeleted++;
            console.log(`[CAMPAIGN CLEANUP] Deleted expired date-keyed upload: ${path.basename(filePath)}`);
          }
        } catch (err) {
          console.error(`[CAMPAIGN CLEANUP] Failed to delete ${filePath}: ${err.message}`);
        }
        // drop the entry from the map regardless
      } else {
        next[dateKey] = meta;
      }
    }
    campaignState.campaignsByDate = next;
  }

  if (deleted > 0 || dateKeyedDeleted > 0) {
    saveCampaignState();
  }

  return { checked, deleted: deleted + dateKeyedDeleted };
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
      campaignsByDate: {},
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
      campaignsByDate: {},
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
      campaignsByDate: (state.campaignsByDate && typeof state.campaignsByDate === "object")
        ? state.campaignsByDate
        : {},
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
        campaignsByDate: campaignState.campaignsByDate || {},
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
      campaignsByDate: {},
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

          if (!nextContacts.has(phone)) nextContacts.set(phone, []);
          nextContacts.get(phone).push({
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

// ============================================================
// TIMEZONE + DATE HELPERS (Eastern Time, DST-safe)
// ============================================================
function getEasternDateString(d = new Date()) {
  // Returns "YYYY-MM-DD" for the current moment in America/New_York.
  // en-CA locale happens to yield ISO "YYYY-MM-DD" format directly.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAMPAIGN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function isValidDateString(s) {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // round-trip check for invalid days (e.g., Feb 30)
  const iso = `${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  return iso === s;
}

function daysBetweenEasternDates(a, b) {
  // Signed day count (a - b) using pure date arithmetic on the strings.
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t1 - t2) / (24 * 60 * 60 * 1000));
}

function csvFileNameForDate(dateStr) {
  return `campaign-${dateStr}.csv`;
}

function csvAbsolutePathForDate(dateStr) {
  return path.resolve(CAMPAIGN_UPLOADS_DIR, csvFileNameForDate(dateStr));
}

// ============================================================
// USER TOKEN STORE
//
// File: data/user-tokens.json
// Shape: { tokens: [ { id, hash, label, created_at, created_by } ] }
// The plaintext token is returned ONCE at creation and never stored.
// ============================================================
function hashToken(plaintext) {
  return crypto.createHash("sha256").update(String(plaintext)).digest("hex");
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

function loadUserTokens() {
  try {
    if (!fs.existsSync(USER_TOKENS_FILE)) return { tokens: [] };
    const raw = fs.readFileSync(USER_TOKENS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tokens)) return { tokens: [] };
    return parsed;
  } catch (err) {
    console.error(`[AUTH] Failed to read user tokens file: ${err.message}`);
    return { tokens: [] };
  }
}

function saveUserTokens(store) {
  try {
    ensureDirectories();
    fs.writeFileSync(USER_TOKENS_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error(`[AUTH] Failed to write user tokens file: ${err.message}`);
  }
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================
function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  const xTok = req.headers["x-campaign-token"];
  if (typeof xTok === "string" && xTok.trim()) return xTok.trim();
  return "";
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function authenticate(req) {
  const presented = extractToken(req);
  if (!presented) return null;

  if (ADMIN_TOKEN && safeEqual(presented, ADMIN_TOKEN)) {
    return { role: "admin", tokenId: "admin", label: "admin" };
  }

  const store = loadUserTokens();
  const presentedHash = hashToken(presented);
  const match = store.tokens.find((t) => safeEqual(t.hash, presentedHash));
  if (match) {
    return { role: "user", tokenId: match.id, label: match.label || match.id };
  }
  return null;
}

function requireAuth(req, res, next) {
  const who = authenticate(req);
  if (!who) {
    return res.status(401).json({ error: "Unauthorized — provide Authorization: Bearer <token> or X-Campaign-Token header" });
  }
  req.auth = who;
  next();
}

function requireAdmin(req, res, next) {
  const who = authenticate(req);
  if (!who) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (who.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  req.auth = who;
  next();
}

// ============================================================
// DATE-KEYED CAMPAIGN ACTIVATION
//
// At request time (and via safety-net timer), if today's ET date has an
// uploaded campaign and that campaign isn't currently active, swap the
// in-memory contacts map to it. Idempotent — safe to call on every
// webhook hit (no-op when already loaded for today).
// ============================================================
async function ensureActiveCampaignForToday() {
  try {
    const today = getEasternDateString();
    if (activeCampaignDate === today) return; // already live

    const byDate = campaignState.campaignsByDate || {};
    const entry = byDate[today];
    if (!entry) return; // no upload for today → leave current active file alone

    const filePath = csvAbsolutePathForDate(today);
    if (!fs.existsSync(filePath)) {
      console.warn(`[CAMPAIGN] campaignsByDate says ${today} exists but file missing: ${filePath}`);
      return;
    }

    const nameColumn = entry.name_column || DEFAULT_NAME_COLUMN;
    const { nextContacts, records, phoneEntries, headers } =
      await buildContactsMapFromCsv(filePath, nameColumn);

    contacts.clear();
    for (const [k, v] of nextContacts.entries()) {
      contacts.set(k, v);
    }

    activeCampaignDate = today;

    campaignState = {
      ...campaignState,
      campaign_id: `date-${today}`,
      csv_file: filePath,
      name_column: detectNameColumn(headers, nameColumn),
      uploaded_at: entry.uploaded_at || campaignState.uploaded_at,
      headers,
      campaignsByDate: byDate,
    };
    saveCampaignState();

    console.log(`[CAMPAIGN] Auto-activated today's (${today}) campaign: ${records} records, ${phoneEntries} phone entries`);
  } catch (err) {
    console.error(`[CAMPAIGN] ensureActiveCampaignForToday failed: ${err.message}`);
    // Never throw — webhook must still work even if activation fails.
  }
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

function getDispositionPortalHtml() {
  const tokenRequired = Boolean(CAMPAIGN_ADMIN_TOKEN);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Disposition Downloads</title>
  <style>
    :root {
      --bg: #f8fafc;
      --surface: #ffffff;
      --text: #0f172a;
      --muted: #475569;
      --border: #e2e8f0;
      --accent: #1d4ed8;
      --accent-soft: #dbeafe;
      --success: #16a34a;
      --danger: #dc2626;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); }
    .wrap { max-width: 1100px; margin: 32px auto; padding: 0 20px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.05); margin-bottom: 16px; }
    h1, h2 { margin: 0 0 8px; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.05rem; }
    .muted { color: var(--muted); font-size: 0.95rem; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
    .pill { display: inline-block; border: 1px solid var(--border); border-radius: 999px; padding: 4px 10px; font-size: 0.82rem; color: var(--muted); margin-right: 8px; margin-top: 8px; }
    input, select, button { border-radius: 10px; font-size: 0.95rem; }
    input, select { border: 1px solid var(--border); padding: 10px 12px; background: #fff; color: var(--text); min-width: 180px; }
    button { border: 1px solid var(--accent); background: var(--accent); color: #fff; padding: 10px 16px; cursor: pointer; font-weight: 600; }
    button.secondary { background: var(--accent-soft); color: #1e3a8a; border-color: #bfdbfe; }
    button.ghost { background: #fff; color: var(--accent); }
    button:disabled, .day-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .status { margin-top: 12px; font-size: 0.92rem; padding: 10px 12px; border-radius: 10px; display: none; white-space: pre-wrap; }
    .status.ok { color: #166534; background: #ecfdf3; border: 1px solid #bbf7d0; }
    .status.error { color: #7f1d1d; background: #fef2f2; border: 1px solid #fecaca; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: 12px; margin-top: 14px; }
    .day-btn { text-align: left; border: 1px solid var(--border); background: #fff; color: var(--text); padding: 12px; border-radius: 12px; }
    .day-btn .date { font-weight: 700; display: block; }
    .day-btn .meta { font-size: 0.84rem; color: var(--muted); display: block; margin-top: 6px; }
    .day-btn.available { border-color: #bfdbfe; background: #eff6ff; }
    .day-btn.available:hover { border-color: var(--accent); }
    .small { font-size: 0.85rem; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Disposition Download Portal</h1>
      <div class="muted">Download disposition CSVs by single date or date range. Only the last ${DISPOSITION_RETENTION_DAYS} days are eligible, using ${escapeHtml(REPORT_TIMEZONE)}.</div>
      <div class="row">
        <span class="pill">Retention: ${DISPOSITION_RETENTION_DAYS} days</span>
        <span class="pill">Timezone: ${escapeHtml(REPORT_TIMEZONE)}</span>
        <span class="pill">Token protected: ${tokenRequired ? "Yes" : "No"}</span>
      </div>
      ${tokenRequired ? `
      <div class="row">
        <input id="tokenInput" type="password" placeholder="Campaign admin token" autocomplete="off" />
        <button id="unlockBtn" class="ghost">Load dates</button>
      </div>
      <div class="small">If the token is configured on Railway, enter it here to load availability and download files.</div>
      ` : ""}
      <div id="status" class="status"></div>
    </div>

    <div class="card">
      <h2>Single-date download</h2>
      <div class="muted">Enabled dates have disposition data. Disabled dates are within retention but currently have no saved records.</div>
      <div id="dateGrid" class="grid"></div>
    </div>

    <div class="card">
      <h2>Date-range download</h2>
      <div class="row">
        <select id="fromDate"></select>
        <select id="toDate"></select>
        <button id="rangeDownloadBtn" class="secondary">Download range CSV</button>
      </div>
      <div class="small">Range download uses only dates that still exist inside the ${DISPOSITION_RETENTION_DAYS}-day window.</div>
    </div>
  </div>

  <script>
    const tokenRequired = ${JSON.stringify(tokenRequired)};
    const statusEl = document.getElementById("status");
    const dateGrid = document.getElementById("dateGrid");
    const fromDate = document.getElementById("fromDate");
    const toDate = document.getElementById("toDate");
    const rangeDownloadBtn = document.getElementById("rangeDownloadBtn");
    const tokenInput = document.getElementById("tokenInput");
    const unlockBtn = document.getElementById("unlockBtn");

    let availability = [];

    function showStatus(text, kind = "ok") {
      statusEl.style.display = "block";
      statusEl.className = "status " + kind;
      statusEl.textContent = text;
    }

    function getHeaders() {
      const headers = {};
      const token = tokenInput ? tokenInput.value.trim() : "";
      if (token) headers["x-campaign-admin-token"] = token;
      return headers;
    }

    function renderGrid() {
      dateGrid.innerHTML = "";
      availability.forEach((item) => {
        const btn = document.createElement("button");
        btn.className = "day-btn" + (item.available ? " available" : "");
        btn.disabled = !item.available;
        btn.innerHTML = '<span class="date">' + item.date + '</span>'
          + '<span class="meta">' + item.count + ' record' + (item.count === 1 ? '' : 's') + (item.isToday ? ' · today' : '') + '</span>';
        btn.addEventListener("click", () => downloadCsv({ date: item.date }));
        dateGrid.appendChild(btn);
      });
    }

    function renderSelects() {
      const availableDates = availability.filter((item) => item.available).map((item) => item.date);
      fromDate.innerHTML = "";
      toDate.innerHTML = "";

      if (!availableDates.length) {
        const opt1 = document.createElement("option");
        opt1.textContent = "No dates available";
        opt1.value = "";
        fromDate.appendChild(opt1);
        const opt2 = opt1.cloneNode(true);
        toDate.appendChild(opt2);
        fromDate.disabled = true;
        toDate.disabled = true;
        rangeDownloadBtn.disabled = true;
        return;
      }

      availableDates.forEach((date) => {
        const fromOpt = document.createElement("option");
        fromOpt.value = date;
        fromOpt.textContent = date;
        fromDate.appendChild(fromOpt);

        const toOpt = document.createElement("option");
        toOpt.value = date;
        toOpt.textContent = date;
        toDate.appendChild(toOpt);
      });

      fromDate.disabled = false;
      toDate.disabled = false;
      rangeDownloadBtn.disabled = false;
      fromDate.value = availableDates[availableDates.length - 1];
      toDate.value = availableDates[0];
    }

    async function loadAvailability() {
      try {
        const res = await fetch("/dispositions/availability", { headers: getHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || "Failed to load availability");
        availability = data.dates || [];
        renderGrid();
        renderSelects();
        showStatus("Availability refreshed.", "ok");
      } catch (err) {
        availability = [];
        renderGrid();
        renderSelects();
        showStatus(err.message || "Failed to load availability.", "error");
      }
    }

    async function downloadCsv(params) {
      try {
        const url = new URL("/dispositions/csv", window.location.origin);
        Object.entries(params || {}).forEach(([key, value]) => {
          if (value) url.searchParams.set(key, value);
        });

        const res = await fetch(url.toString(), { headers: getHeaders() });
        if (!res.ok) {
          const contentType = res.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await res.json();
            throw new Error(data.message || data.error || "Download failed");
          }
          throw new Error("Download failed");
        }

        const blob = await res.blob();
        const disposition = res.headers.get("content-disposition") || "";
        const match = disposition.match(/filename=([^;]+)/i);
        const fileName = match ? match[1].replace(/"/g, "") : "dispositions.csv";
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
        showStatus("CSV download started: " + fileName, "ok");
      } catch (err) {
        showStatus(err.message || "Download failed.", "error");
      }
    }

    rangeDownloadBtn.addEventListener("click", () => {
      if (!fromDate.value || !toDate.value) {
        showStatus("Select a valid start and end date.", "error");
        return;
      }
      if (fromDate.value > toDate.value) {
        showStatus("Start date must be earlier than or equal to end date.", "error");
        return;
      }
      downloadCsv({ from: fromDate.value, to: toDate.value });
    });

    if (unlockBtn) {
      unlockBtn.addEventListener("click", loadAvailability);
    }

    if (!tokenRequired) {
      loadAvailability();
    }
  </script>
</body>
</html>`;
}

function getMonitoringHtml() {
  const tokenRequired = Boolean(CAMPAIGN_ADMIN_TOKEN);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>VTA Monitoring</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;background:#0a0a0a;color:#e5e5e5;padding:24px}
    .wrap{max-width:1200px;margin:0 auto}
    h1{font-size:1.3rem;font-weight:600;margin-bottom:4px}
    .subtitle{color:#737373;font-size:0.85rem;margin-bottom:20px}
    .controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:20px}
    select,input,button{font-family:inherit;font-size:0.85rem;padding:6px 10px;border:1px solid #333;border-radius:6px;background:#171717;color:#e5e5e5;outline:none}
    select:focus,input:focus{border-color:#525252}
    button{cursor:pointer;background:#262626;border-color:#404040}
    button:hover{background:#333}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:24px}
    .stat{background:#171717;border:1px solid #262626;border-radius:10px;padding:14px;text-align:center}
    .stat .val{font-size:1.5rem;font-weight:700;color:#fafafa}
    .stat .lbl{font-size:0.75rem;color:#737373;margin-top:2px}
    .chart-container{background:#171717;border:1px solid #262626;border-radius:10px;padding:16px;margin-bottom:16px}
    .chart-title{font-size:0.85rem;font-weight:600;margin-bottom:10px;color:#a3a3a3}
    canvas{width:100%!important;height:200px!important}
    .legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}
    .legend-item{display:flex;align-items:center;gap:4px;font-size:0.75rem;color:#a3a3a3}
    .legend-dot{width:10px;height:10px;border-radius:2px}
    .status-msg{color:#737373;font-size:0.85rem;margin-top:8px}
    ${tokenRequired ? '.auth-row{margin-bottom:16px;display:flex;gap:8px;align-items:center}' : ''}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>VTA Monitoring</h1>
    <p class="subtitle">Call volume &amp; disposition breakdown — hourly</p>
    ${tokenRequired ? '<div class="auth-row"><input id="token" type="password" placeholder="Admin token"/><button onclick="loadDates()">Unlock</button></div>' : ''}
    <div class="controls">
      <select id="dateSelect"><option value="">Loading...</option></select>
      <button onclick="loadData()">Refresh</button>
      <span class="status-msg" id="statusMsg"></span>
    </div>
    <div class="grid" id="statsGrid"></div>
    <div class="chart-container">
      <div class="chart-title">Calls per Hour</div>
      <canvas id="hourlyChart"></canvas>
      <div class="legend" id="hourlyLegend"></div>
    </div>
    <div class="chart-container">
      <div class="chart-title">Disposition Breakdown</div>
      <canvas id="dispositionChart"></canvas>
      <div class="legend" id="dispositionLegend"></div>
    </div>
  </div>
  <script>
    const COLORS = {
      verified:'#22c55e',wrong_number:'#ef4444',third_party_end:'#f97316',
      consumer_busy_end:'#eab308',dnc:'#dc2626',customer_wants_human:'#3b82f6',
      customer_disconnected:'#6b7280',other:'#a855f7'
    };
    const tokenRequired = ${tokenRequired};
    let allData = [];

    function getHeaders() {
      const h = {'Content-Type':'application/json'};
      const t = tokenRequired && document.getElementById('token') ? document.getElementById('token').value : '';
      if (t) h['x-campaign-admin-token'] = t;
      return h;
    }

    async function loadData() {
      const msg = document.getElementById('statusMsg');
      msg.textContent = 'Loading...';
      try {
        const dateVal = document.getElementById('dateSelect').value;
        const params = new URLSearchParams({limit:'5000'});
        if (dateVal) params.set('date', dateVal);
        const res = await fetch('/dispositions?' + params.toString(), {headers:getHeaders()});
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        const json = await res.json();
        allData = json.dispositions || [];
        render();
        msg.textContent = allData.length + ' entries loaded';
      } catch(e) {
        msg.textContent = 'Error: ' + e.message;
      }
    }

    function render() {
      renderStats();
      renderHourlyChart();
      renderDispositionChart();
    }

    function renderStats() {
      const grid = document.getElementById('statsGrid');
      const total = allData.length;
      const counts = {};
      allData.forEach(d => { counts[d.status] = (counts[d.status]||0) + 1; });
      const upgraded = allData.filter(d => d.initial_status).length;
      let html = '<div class="stat"><div class="val">' + total + '</div><div class="lbl">Total Calls</div></div>';
      html += '<div class="stat"><div class="val">' + (counts.verified||0) + '</div><div class="lbl">Verified</div></div>';
      html += '<div class="stat"><div class="val">' + (counts.customer_wants_human||0) + '</div><div class="lbl">Wants Human</div></div>';
      html += '<div class="stat"><div class="val">' + (counts.customer_disconnected||0) + '</div><div class="lbl">Disconnected</div></div>';
      html += '<div class="stat"><div class="val">' + (counts.wrong_number||0) + '</div><div class="lbl">Wrong Number</div></div>';
      html += '<div class="stat"><div class="val">' + upgraded + '</div><div class="lbl">Upgraded</div></div>';
      grid.innerHTML = html;
    }

    function renderHourlyChart() {
      const canvas = document.getElementById('hourlyChart');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const W = rect.width, H = rect.height;
      ctx.clearRect(0,0,W,H);

      const hourly = new Array(24).fill(0);
      const hourlyVerified = new Array(24).fill(0);
      allData.forEach(d => {
        if (!d.timestamp) return;
        const h = new Date(d.timestamp).getHours();
        hourly[h]++;
        if (d.status === 'verified') hourlyVerified[h]++;
      });

      const max = Math.max(...hourly, 1);
      const padL = 36, padR = 10, padT = 10, padB = 24;
      const chartW = W - padL - padR;
      const chartH = H - padT - padB;
      const barW = chartW / 24;

      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = '#525252'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
        ctx.fillText(Math.round(max * i / 4), padL - 4, y + 3);
      }

      hourly.forEach((v, i) => {
        const x = padL + i * barW + 2;
        const bw = barW - 4;
        const bh = (v / max) * chartH;
        ctx.fillStyle = '#404040';
        ctx.fillRect(x, padT + chartH - bh, bw, bh);
        const vh = (hourlyVerified[i] / max) * chartH;
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(x, padT + chartH - vh, bw, vh);
        if (i % 3 === 0) {
          ctx.fillStyle = '#525252'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
          ctx.fillText(i + ':00', x + bw/2, H - 4);
        }
      });

      const legend = document.getElementById('hourlyLegend');
      legend.innerHTML = '<div class="legend-item"><div class="legend-dot" style="background:#404040"></div>Total</div><div class="legend-item"><div class="legend-dot" style="background:#22c55e"></div>Verified</div>';
    }

    function renderDispositionChart() {
      const canvas = document.getElementById('dispositionChart');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const W = rect.width, H = rect.height;
      ctx.clearRect(0,0,W,H);

      const counts = {};
      allData.forEach(d => { counts[d.status] = (counts[d.status]||0) + 1; });
      const statuses = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
      if (!statuses.length) return;

      const max = Math.max(...Object.values(counts), 1);
      const padL = 36, padR = 10, padT = 10, padB = 40;
      const chartW = W - padL - padR;
      const chartH = H - padT - padB;
      const barW = chartW / statuses.length;

      ctx.strokeStyle = '#333'; ctx.lineWidth = 0.5;
      for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillStyle = '#525252'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
        ctx.fillText(Math.round(max * i / 4), padL - 4, y + 3);
      }

      statuses.forEach((s, i) => {
        const x = padL + i * barW + 4;
        const bw = barW - 8;
        const bh = (counts[s] / max) * chartH;
        ctx.fillStyle = COLORS[s] || '#525252';
        ctx.fillRect(x, padT + chartH - bh, bw, bh);
        ctx.save();
        ctx.translate(x + bw/2, padT + chartH + 6);
        ctx.rotate(-0.5);
        ctx.fillStyle = '#737373'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
        ctx.fillText(s.replace(/_/g,' ').slice(0,14), 0, 0);
        ctx.restore();
      });

      const legend = document.getElementById('dispositionLegend');
      legend.innerHTML = statuses.map(s => '<div class="legend-item"><div class="legend-dot" style="background:' + (COLORS[s]||'#525252') + '"></div>' + s.replace(/_/g,' ') + ' (' + counts[s] + ')</div>').join('');
    }

    async function loadDates() {
      try {
        const res = await fetch('/dispositions/availability', {headers:getHeaders()});
        if (!res.ok) return;
        const json = await res.json();
        const sel = document.getElementById('dateSelect');
        sel.innerHTML = '';
        const dates = json.dates || [];
        if (!dates.length) { sel.innerHTML = '<option value="">No data</option>'; return; }
        dates.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d.date; opt.textContent = d.date + ' (' + d.count + ')';
          sel.appendChild(opt);
        });
        loadData();
      } catch(e) { document.getElementById('statusMsg').textContent = e.message; }
    }

    ${tokenRequired ? '' : 'loadDates();'}
  </script>
</body>
</html>`;
}

app.get("/campaign-portal", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getCampaignPortalHtml());
});

app.get("/dispositions-portal", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getDispositionPortalHtml());
});

app.get("/monitoring", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getMonitoringHtml());
});

app.get("/dispositions/availability", (req, res) => {
  if (!requireCampaignAdminToken(req, res)) return;

  pruneExpiredDispositions();
  res.json({
    retentionDays: DISPOSITION_RETENTION_DAYS,
    timeZone: REPORT_TIMEZONE,
    tokenRequired: Boolean(CAMPAIGN_ADMIN_TOKEN),
    dates: getRecentDispositionAvailability(),
  });
});

app.get("/campaign-state", (req, res) => {
  res.json({
    campaignId: campaignState.campaign_id || "default-contacts",
    activeFile: campaignState.csv_file,
    activeFileName: path.basename(campaignState.csv_file || DEFAULT_CSV_FILE),
    nameColumn: campaignState.name_column || DEFAULT_NAME_COLUMN,
    headers: campaignState.headers || [],
    contactsLoaded: totalContactEntries(),
    uniquePhones: contacts.size,
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
  }
  res.json({ ok: true });
});

// ============================================================
// ROUTE 1: RETELL INBOUND WEBHOOK
// ============================================================
app.post("/retell-webhook", (req, res) => {
  stats.webhookCalls++;
  stats.lastCall = new Date().toISOString();

  // Auto-activate today's date-keyed campaign if uploaded. Fire-and-forget
  // on first hit of the day; subsequent hits are no-ops. Errors are swallowed
  // inside the helper so the webhook always responds.
  ensureActiveCampaignForToday().catch(() => {});

  const fromNumber = req.body?.call_inbound?.from_number || "";
  const normalizedFrom = normalizePhone(fromNumber);

  const queue = contacts.get(normalizedFrom);
  const contact = Array.isArray(queue) && queue.length > 0 ? queue[0] : null;

  if (contact) {
    stats.webhookHits++;
    linkbackTimestamps.delete(normalizedFrom);

    console.log(`[WEBHOOK] ${normalizedFrom} → "${contact.full_name}" (${queue.length} queued)`);

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
  linkbackTimestamps.delete(normalizedFrom);

  console.log(`[WEBHOOK] ${normalizedFrom} → NOT FOUND`);

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

  // Dedup: if call_ended arrived first and created a "customer_disconnected"
  // fallback, update that entry in place instead of creating a duplicate.
  const fallbackEntry = dispositionLog.slice().reverse().find(
    (d) => d.phone === phoneKey && d.status === "customer_disconnected" && d.source === "retell_call_ended"
  );

  if (fallbackEntry) {
    fallbackEntry.initial_status = fallbackEntry.status;
    fallbackEntry.initial_disposition = fallbackEntry.disposition;
    fallbackEntry.status = status;
    fallbackEntry.disposition = getDispositionLabel(status);
    fallbackEntry.summary = summary || fallbackEntry.summary;
    fallbackEntry.full_name = full_name || fallbackEntry.full_name;
    fallbackEntry.source = "log_verification_late";
    stats.customerDisconnectedCount--;
    persistDispositionUpdates();
    console.log(`[VERIFICATION] ${phoneKey}: ${getDispositionLabel(status)} (was customer_disconnected)`);
  } else {
    appendDispositionEntry({
      phone: phoneKey,
      status,
      disposition: getDispositionLabel(status),
      summary: summary || "",
      full_name: full_name || "",
      source: "log_verification",
      timestamp: new Date().toISOString(),
    });
    console.log(`[VERIFICATION] ${phoneKey}: ${getDispositionLabel(status)}`);
  }

  // Queue rotation: pop the front entry so the next call to this phone
  // serves the next person in the CSV.
  if (phoneKey !== "unknown") {
    const queue = contacts.get(phoneKey);
    if (Array.isArray(queue) && queue.length > 0) {
      const consumed = queue.shift();
      if (queue.length === 0) contacts.delete(phoneKey);
    }
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

    const hasVerification = phone.length === 10 && getVerification(phone);
    const hasDispositionEntry = dispositionLog.some(
      (d) => d.phone === phone
        && (d.source === "log_verification" || d.source === "log_verification_late")
        && (Date.now() - new Date(d.timestamp).getTime()) < VERIFICATION_TTL
    );

    if (hasVerification || hasDispositionEntry) {
      const existing = dispositionLog.slice().reverse().find(
        (d) => d.phone === phone && (d.source === "log_verification" || d.source === "log_verification_late")
      );
      if (existing && !existing.call_id) {
        existing.call_id = callId;
        existing.duration_ms = durationMs;
        existing.disconnect_reason = disconnectReason;
        persistDispositionUpdates();
      }
    } else {
      // FALLBACK: Customer hung up before log_verification.
      const fallbackQueue = phone.length === 10 ? contacts.get(phone) : null;
      const contactInfo = Array.isArray(fallbackQueue) && fallbackQueue.length > 0 ? fallbackQueue[0] : null;

      appendDispositionEntry({
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
      console.log(`[CALL ENDED] ${phone}: customer_disconnected (${disconnectReason})`);
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

        let upgradedTo = null;

        if (
          callSuccessful === true
          || cs.includes("confirmed identity")
          || cs.includes("confirmed name")
          || cs.includes("verified")
          || cs.includes("transfer to a representative")
          || cs.includes("transfer to our representative")
          || (cs.includes("confirmed") && cs.includes("transfer"))
        ) {
          upgradedTo = "verified";
          stats.verifiedCount++;
          if (existing.phone && existing.phone.length === 10) {
            storeVerification(existing.phone, {
              status: "verified",
              summary: `Inferred: ${call.call_analysis.call_summary || ""}`,
              full_name: existing.full_name,
            });
          }
        } else if (cs.includes("wrong number") || cs.includes("wrong person")) {
          upgradedTo = "wrong_number";
          stats.wrongNumberCount++;
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
          upgradedTo = "consumer_busy_end";
          stats.consumerBusyEndCount++;
        } else if (cs.includes("third party") || cs.includes("not available") || cs.includes("not home")) {
          upgradedTo = "third_party_end";
          stats.thirdPartyEndCount++;
        } else if (cs.includes("do not call") || cs.includes("stop calling") || cs.includes("remove my number")) {
          upgradedTo = "dnc";
          stats.dncCount++;
        }

        if (upgradedTo) {
          if (!existing.initial_status) {
            existing.initial_status = existing.status;
            existing.initial_disposition = existing.disposition;
          }
          existing.status = upgradedTo;
          existing.disposition = getDispositionLabel(upgradedTo);
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          console.log(`[CALL ANALYZED] ${phone}: ${existing.initial_disposition} → ${existing.disposition}`);
        } else {
          existing.summary = call.call_analysis.call_summary || existing.summary;
        }
      }

      persistDispositionUpdates();
    }
  }

  res.status(204).send();
});

// ============================================================
// ROUTE 5: DISPOSITIONS
// ============================================================
app.get("/dispositions", (req, res) => {
  if (!requireCampaignAdminToken(req, res)) return;

  pruneExpiredDispositions();

  const parsedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;

  let filters;
  try {
    filters = getDispositionFilters(req.query);
  } catch (err) {
    return res.status(400).json({ error: err.message, timezone: REPORT_TIMEZONE });
  }

  const results = filterDispositionEntries(dispositionLog, filters).slice().reverse();

  res.json({
    total: results.length,
    showing: Math.min(results.length, limit),
    filters,
    dispositions: results.slice(0, limit),
  });
});

app.get("/dispositions/csv", (req, res) => {
  if (!requireCampaignAdminToken(req, res)) return;

  pruneExpiredDispositions();

  let filters;
  try {
    filters = getDispositionFilters(req.query);
  } catch (err) {
    return res.status(400).json({ error: err.message, timezone: REPORT_TIMEZONE });
  }

  const withStatus = filterDispositionEntries(dispositionLog, filters);

  const header = "timestamp,phone,disposition,status,initial_disposition,initial_status,summary,full_name,call_id,duration_ms,disconnect_reason,source\n";
  const rows = withStatus.map((d) =>
    [
      d.timestamp || "",
      d.phone || "",
      getDispositionLabel(d.status),
      d.status || "",
      d.initial_disposition || "",
      d.initial_status || "",
      (d.summary || "").replace(/,/g, ";").replace(/\n/g, " "),
      (d.full_name || "").replace(/,/g, ";"),
      d.call_id || "",
      d.duration_ms || "",
      d.disconnect_reason || "",
      d.source || "",
    ].join(",")
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=${buildDispositionCsvFileName(filters)}`);
  res.send(header + rows);
});

// ============================================================
// ROUTE 6: DATE-KEYED CAMPAIGN UPLOAD (multipart, auth required)
//
// POST /campaign/upload
//   Headers: Authorization: Bearer <token>  (user or admin)
//   Form fields (multipart/form-data):
//     date        (required) — YYYY-MM-DD; broadcast date the CSV is for
//     nameColumn  (optional) — overrides auto-detection
//
// Overwrites any existing CSV already uploaded for the same date.
// Does NOT immediately become the active campaign — the file is activated
// automatically when today's ET date matches (via ensureActiveCampaignForToday).
// To activate immediately, admins can call POST /campaign/activate?date=...
// ============================================================
app.post("/campaign/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "file is required (multipart field 'file')" });
    }

    const dateStr = String(req.body?.date || "").trim();
    if (!dateStr) {
      return res.status(400).json({ error: "date is required (YYYY-MM-DD, broadcast date in Eastern time)" });
    }
    if (!isValidDateString(dateStr)) {
      return res.status(400).json({ error: `Invalid date: '${dateStr}'. Expected YYYY-MM-DD.` });
    }

    const csvContent = req.file.buffer.toString("utf-8").replace(/^\uFEFF/, "");
    if (!csvContent.trim()) {
      return res.status(400).json({ error: "Uploaded file is empty" });
    }

    // Parse headers first (for name-column detection and validation).
    const preview = await parseCsvPreview(csvContent, 1);
    if (!preview.headers.length) {
      return res.status(400).json({ error: "CSV has no header row" });
    }

    const requestedNameColumn = String(req.body?.nameColumn || "").trim();
    const selectedNameColumn = detectNameColumn(preview.headers, requestedNameColumn);

    // Persist to disk atomically. Write to .tmp first, then rename — overwrites
    // any existing file for the same date in a single filesystem operation.
    ensureDirectories();
    const targetPath = csvAbsolutePathForDate(dateStr);
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, csvContent, "utf-8");
    fs.renameSync(tmpPath, targetPath);

    // Build the contacts map off the stored file (validates end-to-end).
    const { nextContacts, records, phoneEntries, headers } =
      await buildContactsMapFromCsv(targetPath, selectedNameColumn);

    if (records === 0) {
      try { fs.unlinkSync(targetPath); } catch {}
      return res.status(400).json({ error: "CSV parsed but contained 0 rows" });
    }
    if (phoneEntries === 0) {
      try { fs.unlinkSync(targetPath); } catch {}
      return res.status(400).json({
        error: "CSV parsed but no valid phone numbers were found. Expected at least one of: " + PHONE_COLUMNS.join(", "),
      });
    }

    // Record the upload in state.
    const byDate = campaignState.campaignsByDate || {};
    const existing = byDate[dateStr];
    const overwritten = Boolean(existing);
    const originalFileName = String(req.file.originalname || "uploaded.csv");
    byDate[dateStr] = {
      file_name: csvFileNameForDate(dateStr),
      original_file_name: originalFileName,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.auth.label || req.auth.tokenId,
      uploader_role: req.auth.role,
      name_column: selectedNameColumn,
      records,
      phone_entries: phoneEntries,
      headers,
    };
    campaignState.campaignsByDate = byDate;
    saveCampaignState();

    // If the uploaded date is today (ET), activate immediately.
    const today = getEasternDateString();
    let activatedNow = false;
    if (dateStr === today) {
      contacts.clear();
      for (const [k, v] of nextContacts.entries()) {
        contacts.set(k, v);
      }
      activeCampaignDate = today;
      campaignState = {
        ...campaignState,
        campaign_id: `date-${today}`,
        csv_file: targetPath,
        name_column: selectedNameColumn,
        uploaded_at: byDate[today].uploaded_at,
        headers,
      };
      saveCampaignState();
      activatedNow = true;
      console.log(`[CAMPAIGN UPLOAD] ${req.auth.label} uploaded for TODAY (${today}) — activated immediately (${records} records, ${phoneEntries} phones)`);
    } else {
      console.log(`[CAMPAIGN UPLOAD] ${req.auth.label} uploaded for ${dateStr} (${records} records, ${phoneEntries} phones)${overwritten ? " [OVERWROTE PREVIOUS]" : ""}`);
    }

    pruneOldUploadedCampaigns();

    return res.json({
      success: true,
      date: dateStr,
      overwritten,
      activatedNow,
      willActivateOn: activatedNow ? null : `${dateStr} (first webhook hit in America/New_York)`,
      records,
      phoneEntries,
      nameColumn: selectedNameColumn,
      fileName: csvFileNameForDate(dateStr),
      originalFileName,
      uploadedBy: req.auth.label || req.auth.tokenId,
    });
  } catch (err) {
    console.error(`[CAMPAIGN UPLOAD] Error: ${err.message}`);
    return res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
});

// Force-activate a previously uploaded date's campaign (admin only).
// Useful to test a future date's list right now without waiting for ET rollover.
app.post("/campaign/activate", requireAdmin, async (req, res) => {
  try {
    const dateStr = String(req.query?.date || req.body?.date || "").trim();
    if (!isValidDateString(dateStr)) {
      return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
    }

    const entry = (campaignState.campaignsByDate || {})[dateStr];
    if (!entry) {
      return res.status(404).json({ error: `No uploaded campaign for ${dateStr}` });
    }

    const filePath = csvAbsolutePathForDate(dateStr);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `File missing on disk for ${dateStr}` });
    }

    const nameColumn = entry.name_column || DEFAULT_NAME_COLUMN;
    const { nextContacts, records, phoneEntries, headers } =
      await buildContactsMapFromCsv(filePath, nameColumn);

    contacts.clear();
    for (const [k, v] of nextContacts.entries()) {
      contacts.set(k, v);
    }
    activeCampaignDate = dateStr;
    campaignState = {
      ...campaignState,
      campaign_id: `date-${dateStr}`,
      csv_file: filePath,
      name_column: detectNameColumn(headers, nameColumn),
      uploaded_at: entry.uploaded_at,
      headers,
    };
    saveCampaignState();

    console.log(`[CAMPAIGN ACTIVATE] Admin force-activated ${dateStr} (${records} records, ${phoneEntries} phones)`);
    return res.json({
      success: true,
      activated: dateStr,
      records,
      phoneEntries,
      nameColumn: campaignState.name_column,
    });
  } catch (err) {
    console.error(`[CAMPAIGN ACTIVATE] Error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ROUTE 7: ADMIN — VIEW / DELETE DATE-KEYED UPLOADS
// ============================================================
app.get("/admin/uploads", requireAdmin, (req, res) => {
  const today = getEasternDateString();
  const byDate = campaignState.campaignsByDate || {};
  const uploads = Object.entries(byDate)
    .map(([dateKey, meta]) => {
      const filePath = csvAbsolutePathForDate(dateKey);
      const onDisk = fs.existsSync(filePath);
      let fileSize = null;
      let mtime = null;
      if (onDisk) {
        try {
          const st = fs.statSync(filePath);
          fileSize = st.size;
          mtime = new Date(st.mtimeMs).toISOString();
        } catch {}
      }
      const ageDays = daysBetweenEasternDates(today, dateKey);
      return {
        date: dateKey,
        file_name: meta.file_name,
        original_file_name: meta.original_file_name,
        uploaded_at: meta.uploaded_at,
        uploaded_by: meta.uploaded_by,
        name_column: meta.name_column,
        records: meta.records,
        phone_entries: meta.phone_entries,
        on_disk: onDisk,
        file_size_bytes: fileSize,
        file_mtime: mtime,
        age_days_et: ageDays,
        is_active: activeCampaignDate === dateKey,
        is_today: dateKey === today,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json({
    timezone: CAMPAIGN_TIMEZONE,
    today_et: today,
    retention_days: CAMPAIGN_RETENTION_DAYS,
    active_campaign_date: activeCampaignDate,
    total: uploads.length,
    uploads,
  });
});

app.delete("/admin/uploads/:date", requireAdmin, (req, res) => {
  const dateStr = String(req.params.date || "").trim();
  if (!isValidDateString(dateStr)) {
    return res.status(400).json({ error: "Invalid date format (YYYY-MM-DD)" });
  }

  const byDate = campaignState.campaignsByDate || {};
  const entry = byDate[dateStr];
  if (!entry) {
    return res.status(404).json({ error: `No uploaded campaign for ${dateStr}` });
  }

  const filePath = csvAbsolutePathForDate(dateStr);
  let fileDeleted = false;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      fileDeleted = true;
    }
  } catch (err) {
    console.error(`[ADMIN DELETE] Failed to delete ${filePath}: ${err.message}`);
    return res.status(500).json({ error: `Failed to delete file: ${err.message}` });
  }

  delete byDate[dateStr];
  campaignState.campaignsByDate = byDate;

  // If the deleted date is the currently-active campaign, fall back to
  // default contacts.csv and reload the in-memory map. This prevents the
  // webhook from pointing at a now-missing file.
  let fallbackLoaded = false;
  if (activeCampaignDate === dateStr) {
    activeCampaignDate = null;
    if (fs.existsSync(DEFAULT_CSV_FILE)) {
      try {
        buildContactsMapFromCsv(DEFAULT_CSV_FILE, DEFAULT_NAME_COLUMN).then(
          ({ nextContacts, records, phoneEntries, headers }) => {
            contacts.clear();
            for (const [k, v] of nextContacts.entries()) contacts.set(k, v);
            campaignState = {
              ...campaignState,
              campaign_id: "default-contacts",
              csv_file: DEFAULT_CSV_FILE,
              name_column: DEFAULT_NAME_COLUMN,
              uploaded_at: null,
              headers,
            };
            saveCampaignState();
            console.log(`[ADMIN DELETE] Fell back to default contacts.csv (${records} records, ${phoneEntries} phones)`);
          }
        ).catch((e) => console.error(`[ADMIN DELETE] Fallback load failed: ${e.message}`));
        fallbackLoaded = true;
      } catch (e) {
        console.error(`[ADMIN DELETE] Fallback scheduling failed: ${e.message}`);
      }
    }
  }

  saveCampaignState();
  console.log(`[ADMIN DELETE] Admin deleted date-keyed upload for ${dateStr}`);

  return res.json({
    success: true,
    date: dateStr,
    file_deleted: fileDeleted,
    fallback_triggered: fallbackLoaded,
  });
});

// ============================================================
// ROUTE 8: ADMIN — USER TOKEN MANAGEMENT
//
// Admin-only. Create / list / revoke user tokens that can upload campaigns
// and download dispositions. Plaintext token is returned exactly once at
// creation time (like an API-key flow). We only store SHA-256 hashes on disk.
// ============================================================
app.get("/admin/users", requireAdmin, (req, res) => {
  const store = loadUserTokens();
  const tokens = store.tokens.map((t) => ({
    id: t.id,
    label: t.label,
    created_at: t.created_at,
    created_by: t.created_by,
    // last-4 of hash for quick visual diff, never the token itself
    hash_last4: String(t.hash || "").slice(-4),
  }));
  res.json({ total: tokens.length, tokens });
});

app.post("/admin/users", requireAdmin, (req, res) => {
  const label = String(req.body?.label || "").trim();
  if (!label) {
    return res.status(400).json({ error: "label is required" });
  }
  const store = loadUserTokens();
  if (store.tokens.some((t) => t.label === label)) {
    return res.status(409).json({ error: `A token with label '${label}' already exists` });
  }

  const plaintext = generateToken();
  const id = `usr_${crypto.randomBytes(8).toString("hex")}`;
  const record = {
    id,
    label,
    hash: hashToken(plaintext),
    created_at: new Date().toISOString(),
    created_by: req.auth.label || req.auth.tokenId,
  };
  store.tokens.push(record);
  saveUserTokens(store);

  console.log(`[ADMIN USERS] Admin created token ${id} (${label})`);
  res.status(201).json({
    id,
    label,
    token: plaintext, // returned ONCE; store it securely
    note: "This plaintext token is shown only once. Store it now — it cannot be retrieved later.",
  });
});

app.delete("/admin/users/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "").trim();
  const store = loadUserTokens();
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((t) => t.id !== id);
  if (store.tokens.length === before) {
    return res.status(404).json({ error: `No token with id ${id}` });
  }
  saveUserTokens(store);
  console.log(`[ADMIN USERS] Admin revoked token ${id}`);
  res.json({ success: true, revoked: id });
});

// ============================================================
// ROUTE 9: AUTH IDENTITY — who am I?
// Convenience for the caller to verify their token works and see their role.
// ============================================================
app.get("/auth/whoami", requireAuth, (req, res) => {
  res.json({
    role: req.auth.role,
    tokenId: req.auth.tokenId,
    label: req.auth.label,
  });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => {
  pruneExpiredDispositions();

  res.json({
    status: "ok",
    contacts_loaded: totalContactEntries(),
    unique_phones: contacts.size,
    active_campaign_id: campaignState.campaign_id,
    active_campaign_file: campaignState.csv_file,
    active_campaign_name_column: campaignState.name_column,
    campaign_retention_days: CAMPAIGN_RETENTION_DAYS,
    disposition_retention_days: DISPOSITION_RETENTION_DAYS,
    reporting_timezone: REPORT_TIMEZONE,
    activeVerifications: verificationResults.size,
    totalDispositions: dispositionLog.filter((d) => d.status).length,
    ...stats,
    uptime: Math.floor(process.uptime()),
  });
});

// ============================================================
// STARTUP
// ============================================================
loadDispositionLogFromDisk();

loadContacts()
  .then(async () => {
    if (!CSV_FILE_OVERRIDE) {
      const cleanupResult = pruneOldUploadedCampaigns();
      console.log(`[CAMPAIGN CLEANUP] Startup check complete. Checked: ${cleanupResult.checked}, Deleted: ${cleanupResult.deleted}`);
      setInterval(() => {
        const result = pruneOldUploadedCampaigns();
        if (result.deleted > 0) {
          console.log(`[CAMPAIGN CLEANUP] Interval run. Checked: ${result.checked}, Deleted: ${result.deleted}`);
        }
      }, 6 * 60 * 60 * 1000);

      // If there's already a date-keyed upload for today's ET date, swap to it
      // on boot (e.g., after a Railway redeploy mid-day).
      await ensureActiveCampaignForToday();

      // Safety-net: re-check every 10 minutes so rollover across midnight ET
      // picks up the next day's campaign even if no webhook fires right at 00:00.
      setInterval(() => {
        ensureActiveCampaignForToday().catch(() => {});
      }, 10 * 60 * 1000);
    }

    const dispositionCleanupResult = pruneExpiredDispositions();
    console.log(`[DISPOSITIONS] Startup cleanup complete. Checked: ${dispositionCleanupResult.checked}, Deleted: ${dispositionCleanupResult.deleted}`);
    setInterval(() => {
      const result = pruneExpiredDispositions();
      if (result.deleted > 0) {
        console.log(`[DISPOSITIONS] Interval cleanup complete. Checked: ${result.checked}, Deleted: ${result.deleted}`);
      }
    }, 60 * 60 * 1000);

    app.listen(PORT, () => {
      console.log(`\nVTA Webhook running on port ${PORT}`);
      console.log(`Phone entries indexed: ${totalContactEntries()} (${contacts.size} unique phones)`);
      console.log(`Active campaign ID: ${campaignState.campaign_id}`);
      console.log(`Active campaign file: ${campaignState.csv_file}`);
      console.log(`Active name column: ${campaignState.name_column}`);
      console.log(`Campaign retention: ${CAMPAIGN_RETENTION_DAYS} days`);
      console.log(`Disposition retention: ${DISPOSITION_RETENTION_DAYS} days (${REPORT_TIMEZONE})`);
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
      console.log(`  GET  /dispositions-portal    → Filtered disposition download UI`);
      console.log(`  GET  /monitoring             → Live call volume & disposition charts`);
      console.log(`  GET  /dispositions           → View dispositions (JSON)`);
      console.log(`  GET  /dispositions/availability → Recent disposition dates/counts`);
      console.log(`  GET  /dispositions/csv       → Download dispositions (CSV; supports ?date=YYYY-MM-DD or ?from=YYYY-MM-DD&to=YYYY-MM-DD)`);
      console.log(`  GET  /linkback-start          → TCN pre-linkback timer ping`);
      console.log(`  GET  /health                 → Health check`);
      console.log(`  POST /campaign/upload        → [auth] Upload date-keyed CSV (multipart, date required)`);
      console.log(`  POST /campaign/activate      → [admin] Force-activate ?date=YYYY-MM-DD now`);
      console.log(`  GET  /admin/uploads          → [admin] List all date-keyed uploads`);
      console.log(`  DEL  /admin/uploads/:date    → [admin] Delete a specific date's CSV`);
      console.log(`  GET  /admin/users            → [admin] List user tokens`);
      console.log(`  POST /admin/users            → [admin] Create user token (returns plaintext once)`);
      console.log(`  DEL  /admin/users/:id        → [admin] Revoke a user token`);
      console.log(`  GET  /auth/whoami            → [auth]  Inspect the presented token's role`);
      if (!ADMIN_TOKEN) {
        console.log(`\n⚠  CAMPAIGN_ADMIN_TOKEN env var is NOT set — admin endpoints are unreachable.`);
        console.log(`   Set it in Railway to enable admin access. Date-keyed uploads and downloads are still protected by user tokens.`);
      } else {
        console.log(`\n✓ Admin auth: CAMPAIGN_ADMIN_TOKEN set (${ADMIN_TOKEN.length} chars)`);
      }
    });
  })
  .catch((err) => {
    console.error("Failed to load contacts:", err);
    process.exit(1);
  });