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

function toEST(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleString("en-US", { timeZone: CAMPAIGN_TIMEZONE, hour12: false }).replace(",", "");
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
            // Second-ID verification fields (two-step prompt). Lowercase keys —
            // the LiveKit worker reads dynamic_variables.dob / .addr1 / .city /
            // .state / .zip verbatim and composes the spoken mailing address.
            dob: (row["DOB"] || "").trim(),
            addr1: (row["ADDR1"] || "").trim(),
            addr2: (row["ADDR2"] || "").trim(),
            city: (row["CITY"] || "").trim(),
            state: (row["STATE"] || "").trim(),
            zip: (row["ZIP"] || "").trim(),
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
  <title>VTA Console</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #171717;
      --surface-2: #1f1f1f;
      --border: #262626;
      --border-strong: #404040;
      --text: #fafafa;
      --text-muted: #a3a3a3;
      --text-dim: #525252;
      --accent: #d97757;
      --accent-soft: rgba(217, 119, 87, 0.12);
      --green: #22c55e;
      --green-soft: rgba(34, 197, 94, 0.12);
      --red: #ef4444;
      --red-dark: #dc2626;
      --blue: #3b82f6;
      --gray: #71717a;
      --purple: #a855f7;
      --orange: #f97316;
      --yellow: #eab308;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
      background:var(--bg);color:var(--text);padding:24px;min-height:100vh;
      font-feature-settings:"cv11","ss01";
    }
    .mono{font-family:'JetBrains Mono','SF Mono',SFMono-Regular,Consolas,Menlo,monospace;font-variant-numeric:tabular-nums}
    .wrap{max-width:1400px;margin:0 auto}
    .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:16px}
    .title h1{font-size:1.5rem;font-weight:600;letter-spacing:-0.02em;margin-bottom:4px}
    .title p{color:var(--text-muted);font-size:0.875rem}
    .live-indicator{display:flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--border);border-radius:999px;font-size:0.8rem;color:var(--text-muted)}
    .live-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 var(--green);animation:pulse 2s infinite}
    .live-dot.paused{background:var(--text-dim);animation:none;box-shadow:none}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,0.4)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
    .toolbar{display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:24px;padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
    .pill-group{display:flex;gap:4px;background:var(--bg);padding:3px;border-radius:8px;border:1px solid var(--border)}
    .pill{padding:5px 12px;font-size:0.8rem;border:none;background:transparent;color:var(--text-muted);cursor:pointer;border-radius:6px;font-family:inherit;font-weight:500;transition:all 200ms}
    .pill:hover{color:var(--text)}
    .pill.active{background:var(--surface-2);color:var(--text);box-shadow:0 0 0 1px var(--border-strong)}
    .sep{width:1px;height:20px;background:var(--border)}
    select,input[type=date]{font-family:inherit;font-size:0.8rem;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);outline:none;cursor:pointer}
    select:hover,input[type=date]:hover{border-color:var(--border-strong)}
    select:focus,input[type=date]:focus{border-color:var(--text-dim)}
    .icon-btn{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text-muted);cursor:pointer;transition:all 200ms}
    .icon-btn:hover{border-color:var(--border-strong);color:var(--text)}
    .icon-btn svg{width:14px;height:14px}
    .updated{margin-left:auto;font-size:0.75rem;color:var(--text-dim);display:flex;align-items:center;gap:8px}
    .refresh-ring{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:none}
    .refresh-ring.spinning{animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}

    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;position:relative;overflow:hidden;transition:border-color 200ms}
    .stat-card:hover{border-color:var(--border-strong)}
    .stat-label{font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);font-weight:600;margin-bottom:6px}
    .stat-value{font-size:1.75rem;font-weight:600;letter-spacing:-0.02em;line-height:1;margin-bottom:4px}
    .stat-trend{font-size:0.7rem;color:var(--text-dim);display:flex;align-items:center;gap:4px}
    .stat-trend.up{color:var(--green)}
    .stat-trend.down{color:var(--red)}
    .stat-spark{height:24px;margin-top:8px}

    .grid-2{display:grid;grid-template-columns:2fr 1fr;gap:16px;margin-bottom:16px}
    @media(max-width:900px){.grid-2{grid-template-columns:1fr}}
    .panel{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px}
    .panel-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
    .panel-title{font-size:0.875rem;font-weight:600;color:var(--text);letter-spacing:-0.01em}
    .panel-subtitle{font-size:0.7rem;color:var(--text-dim);margin-top:1px}
    .legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:12px;font-size:0.75rem}
    .legend-item{display:flex;align-items:center;gap:6px;color:var(--text-muted)}
    .legend-dot{width:8px;height:8px;border-radius:2px}

    .h-bar-list{display:flex;flex-direction:column;gap:10px}
    .h-bar-row{display:grid;grid-template-columns:120px 1fr 50px;gap:10px;align-items:center;font-size:0.8rem}
    .h-bar-label{color:var(--text-muted);font-size:0.75rem}
    .h-bar-track{height:8px;background:var(--bg);border-radius:4px;overflow:hidden;position:relative}
    .h-bar-fill{height:100%;border-radius:4px;transition:width 400ms cubic-bezier(0.4,0,0.2,1)}
    .h-bar-count{text-align:right;color:var(--text);font-weight:500}

    .feed{max-height:400px;overflow-y:auto}
    .feed::-webkit-scrollbar{width:6px}
    .feed::-webkit-scrollbar-track{background:transparent}
    .feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
    .feed::-webkit-scrollbar-thumb:hover{background:var(--border-strong)}
    .feed-row{display:grid;grid-template-columns:80px 18px 110px 1fr;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--border);font-size:0.8rem;animation:fadein 300ms ease-out}
    @keyframes fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
    .feed-row:last-child{border-bottom:none}
    .feed-time{color:var(--text-dim);font-size:0.7rem}
    .feed-status-dot{width:8px;height:8px;border-radius:50%;justify-self:center}
    .feed-phone{color:var(--text-muted);letter-spacing:0.02em}
    .feed-name{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .feed-status-label{color:var(--text-dim);font-size:0.7rem;text-transform:lowercase}

    .toast{position:fixed;top:24px;right:24px;background:var(--surface);border:1px solid var(--red);color:var(--text);padding:10px 16px;border-radius:8px;font-size:0.8rem;box-shadow:0 8px 24px rgba(0,0,0,0.4);z-index:1000;animation:slidein 200ms ease-out}
    .toast.success{border-color:var(--green)}
    @keyframes slidein{from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
    .skeleton{background:linear-gradient(90deg,var(--surface) 0%,var(--surface-2) 50%,var(--surface) 100%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:6px;height:1.5rem}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

    .auth-overlay{position:fixed;inset:0;background:rgba(10,10,10,0.95);display:none;align-items:center;justify-content:center;z-index:100}
    .auth-overlay.show{display:flex}
    .auth-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:340px;max-width:90vw}
    .auth-card h2{font-size:1.1rem;font-weight:600;margin-bottom:6px}
    .auth-card p{font-size:0.825rem;color:var(--text-muted);margin-bottom:20px}
    .auth-card input{width:100%;font-size:0.875rem;padding:9px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);outline:none;margin-bottom:12px;font-family:inherit}
    .auth-card input:focus{border-color:var(--accent)}
    .auth-card button{width:100%;font-size:0.875rem;font-weight:500;padding:10px;border:none;border-radius:6px;background:var(--accent);color:#000;cursor:pointer;font-family:inherit;transition:opacity 200ms}
    .auth-card button:hover{opacity:0.9}
    .auth-error{color:var(--red);font-size:0.8rem;margin-top:8px;display:none}
    .auth-error.show{display:block}
  </style>
</head>
<body>
  ${tokenRequired ? `
  <div class="auth-overlay show" id="authOverlay">
    <div class="auth-card">
      <h2>Authentication Required</h2>
      <p>Enter your admin token to access the console.</p>
      <input id="tokenInput" type="password" placeholder="Admin token" autocomplete="off"/>
      <button onclick="authenticate()">Unlock</button>
      <div class="auth-error" id="authError"></div>
    </div>
  </div>` : ''}

  <div class="wrap">
    <div class="header">
      <div class="title">
        <h1>VTA Console</h1>
        <p>Real-time call monitoring &amp; dispositions</p>
      </div>
      <div class="live-indicator">
        <span class="live-dot" id="liveDot"></span>
        <span id="liveLabel">Live · auto 30s</span>
      </div>
    </div>

    <div class="toolbar">
      <div class="pill-group" id="rangeGroup">
        <button class="pill active" data-range="today">Today</button>
        <button class="pill" data-range="yesterday">Yesterday</button>
        <button class="pill" data-range="7d">Last 7 days</button>
        <button class="pill" data-range="custom">Custom</button>
      </div>
      <input type="date" id="customDate" style="display:none"/>
      <div class="sep"></div>
      <select id="statusFilter">
        <option value="">All statuses</option>
        <option value="verified">Verified only</option>
        <option value="customer_disconnected">Disconnected only</option>
        <option value="wrong_number">Wrong Number only</option>
        <option value="customer_wants_human">Wants Human only</option>
        <option value="dnc">DNC only</option>
        <option value="third_party_end">Third Party only</option>
        <option value="consumer_busy_end">Consumer Busy only</option>
      </select>
      <button class="icon-btn" id="pauseBtn" title="Pause auto-refresh">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
      </button>
      <button class="icon-btn" id="refreshBtn" title="Refresh now (R)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
      </button>
      <div class="updated">
        <div class="refresh-ring" id="refreshRing"></div>
        <span id="updatedLabel">—</span>
      </div>
    </div>

    <div class="stats" id="statsGrid"></div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Call Volume</div>
            <div class="panel-subtitle" id="volumeSubtitle">Hourly breakdown</div>
          </div>
        </div>
        <canvas id="volumeChart" style="width:100%;height:240px"></canvas>
        <div class="legend">
          <div class="legend-item"><div class="legend-dot" style="background:#525252"></div>Total</div>
          <div class="legend-item"><div class="legend-dot" style="background:#22c55e"></div>Verified</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Disposition Breakdown</div>
            <div class="panel-subtitle">All statuses</div>
          </div>
        </div>
        <div class="h-bar-list" id="dispositionList"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Recent Activity</div>
          <div class="panel-subtitle" id="feedSubtitle">Latest dispositions, newest first</div>
        </div>
      </div>
      <div class="feed" id="activityFeed"></div>
    </div>
  </div>

  <script>
    const COLORS = {
      verified:'#22c55e',
      wrong_number:'#ef4444',
      third_party_end:'#f97316',
      consumer_busy_end:'#eab308',
      dnc:'#dc2626',
      customer_wants_human:'#3b82f6',
      customer_disconnected:'#71717a',
      other:'#a855f7'
    };
    const LABELS = {
      verified:'Verified',
      wrong_number:'Wrong Number',
      third_party_end:'Third Party',
      consumer_busy_end:'Consumer Busy',
      dnc:'DNC',
      customer_wants_human:'Wants Human',
      customer_disconnected:'Disconnected',
      other:'Other'
    };
    const tokenRequired = ${tokenRequired};
    const REFRESH_INTERVAL_MS = 30000;
    let allData = [];
    let filteredData = [];
    let currentRange = 'today';
    let currentStatus = '';
    let customDate = '';
    let authToken = '';
    let lastFetchTs = 0;
    let refreshTimer = null;
    let countdownTimer = null;
    let paused = false;

    function getHeaders() {
      const h = {'Content-Type':'application/json'};
      if (tokenRequired && authToken) h['x-campaign-admin-token'] = authToken;
      return h;
    }

    function authenticate() {
      const inp = document.getElementById('tokenInput');
      const err = document.getElementById('authError');
      authToken = inp.value.trim();
      if (!authToken) { err.textContent = 'Token required'; err.classList.add('show'); return; }
      fetch('/dispositions/availability', {headers:getHeaders()})
        .then(r => {
          if (!r.ok) throw new Error('Invalid token');
          document.getElementById('authOverlay').classList.remove('show');
          err.classList.remove('show');
          init();
        })
        .catch(e => { err.textContent = e.message; err.classList.add('show'); });
    }

    function getDatesForRange(range) {
      const now = new Date();
      const todayStr = ymd(now);
      if (range === 'today') return [todayStr];
      if (range === 'yesterday') {
        const y = new Date(now); y.setDate(y.getDate() - 1);
        return [ymd(y)];
      }
      if (range === '7d') {
        const dates = [];
        for (let i = 0; i < 7; i++) {
          const d = new Date(now); d.setDate(d.getDate() - i);
          dates.push(ymd(d));
        }
        return dates;
      }
      if (range === 'custom' && customDate) return [customDate];
      return [todayStr];
    }

    function ymd(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth()+1).padStart(2,'0');
      const day = String(d.getDate()).padStart(2,'0');
      return y + '-' + m + '-' + day;
    }

    async function fetchData() {
      const ring = document.getElementById('refreshRing');
      ring.classList.add('spinning');
      try {
        const dates = getDatesForRange(currentRange);
        const params = new URLSearchParams({limit:'5000'});
        if (currentRange === '7d') {
          params.set('from', dates[dates.length-1]);
          params.set('to', dates[0]);
        } else if (dates.length === 1) {
          params.set('date', dates[0]);
        }
        const res = await fetch('/dispositions?' + params.toString(), {headers:getHeaders()});
        if (!res.ok) throw new Error('Failed to load (' + res.status + ')');
        const json = await res.json();
        allData = json.dispositions || [];
        lastFetchTs = Date.now();
        applyFilters();
        render();
        updateLabel();
      } catch(e) {
        showToast(e.message, false);
      } finally {
        setTimeout(() => ring.classList.remove('spinning'), 400);
      }
    }

    function applyFilters() {
      filteredData = currentStatus
        ? allData.filter(d => d.status === currentStatus)
        : allData.slice();
    }

    function render() {
      renderStats();
      renderVolumeChart();
      renderDispositionList();
      renderActivityFeed();
    }

    function renderStats() {
      const grid = document.getElementById('statsGrid');
      const total = filteredData.length;
      const counts = {};
      filteredData.forEach(d => { counts[d.status] = (counts[d.status]||0) + 1; });
      const rate = total > 0 ? ((counts.verified||0) / total * 100).toFixed(1) : '0.0';
      const cards = [
        { label:'Total Calls', value:total, key:'total' },
        { label:'Verified', value:counts.verified||0, key:'verified', color:'#22c55e' },
        { label:'Wants Human', value:counts.customer_wants_human||0, key:'customer_wants_human', color:'#3b82f6' },
        { label:'Disconnected', value:counts.customer_disconnected||0, key:'customer_disconnected' },
        { label:'Wrong Number', value:counts.wrong_number||0, key:'wrong_number', color:'#ef4444' },
        { label:'Verification Rate', value:rate + '%', key:'rate', color:'#d97757' },
      ];
      grid.innerHTML = cards.map(c =>
        '<div class="stat-card">' +
          '<div class="stat-label">' + c.label + '</div>' +
          '<div class="stat-value mono"' + (c.color ? ' style="color:' + c.color + '"' : '') + '>' + c.value + '</div>' +
          '<canvas class="stat-spark" data-key="' + c.key + '"></canvas>' +
        '</div>'
      ).join('');
      document.querySelectorAll('.stat-spark').forEach(c => renderSparkline(c, c.dataset.key));
    }

    function renderSparkline(canvas, key) {
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const W = rect.width, H = rect.height;
      ctx.clearRect(0,0,W,H);
      const hourly = new Array(24).fill(0);
      const totals = new Array(24).fill(0);
      filteredData.forEach(d => {
        if (!d.timestamp) return;
        const h = new Date(d.timestamp).getHours();
        totals[h]++;
        if (key === 'total') hourly[h]++;
        else if (key === 'rate') {}
        else if (d.status === key) hourly[h]++;
      });
      let series = hourly;
      if (key === 'rate') {
        series = totals.map((t, i) => {
          const v = filteredData.filter(d => d.timestamp && new Date(d.timestamp).getHours() === i && d.status === 'verified').length;
          return t > 0 ? (v / t) * 100 : 0;
        });
      }
      const max = Math.max(...series, 1);
      const stroke = key === 'verified' ? '#22c55e' :
                     key === 'rate' ? '#d97757' :
                     key === 'wrong_number' ? '#ef4444' :
                     key === 'customer_wants_human' ? '#3b82f6' :
                     '#a3a3a3';
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const points = series.map((v, i) => ({ x: (i / 23) * W, y: H - (v / max) * (H - 2) - 1 }));
      drawSmoothLine(ctx, points);
      ctx.stroke();
      // area fill
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, stroke + '40');
      grad.addColorStop(1, stroke + '00');
      ctx.fillStyle = grad;
      ctx.lineTo(W, H);
      ctx.lineTo(0, H);
      ctx.closePath();
      ctx.fill();
    }

    function drawSmoothLine(ctx, pts) {
      if (!pts.length) return;
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i-1], p1 = pts[i];
        const cpx = (p0.x + p1.x) / 2;
        ctx.bezierCurveTo(cpx, p0.y, cpx, p1.y, p1.x, p1.y);
      }
    }

    function renderVolumeChart() {
      const canvas = document.getElementById('volumeChart');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
      const W = rect.width, H = rect.height;
      ctx.clearRect(0,0,W,H);

      const hourly = new Array(24).fill(0);
      const verified = new Array(24).fill(0);
      filteredData.forEach(d => {
        if (!d.timestamp) return;
        const h = new Date(d.timestamp).getHours();
        hourly[h]++;
        if (d.status === 'verified') verified[h]++;
      });

      const max = Math.max(...hourly, 1);
      const padL = 44, padR = 16, padT = 12, padB = 32;
      const chartW = W - padL - padR;
      const chartH = H - padT - padB;

      // grid
      ctx.strokeStyle = '#262626';
      ctx.lineWidth = 1;
      ctx.font = '10px JetBrains Mono, SF Mono, monospace';
      ctx.fillStyle = '#525252';
      ctx.textAlign = 'right';
      for (let i = 0; i <= 4; i++) {
        const y = padT + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(Math.round(max * i / 4), padL - 6, y + 3);
      }
      // x-axis labels
      ctx.textAlign = 'center';
      for (let i = 0; i < 24; i += 3) {
        const x = padL + (i / 23) * chartW;
        ctx.fillText(String(i).padStart(2,'0') + ':00', x, H - padB + 16);
      }

      // total line + area
      const totalPts = hourly.map((v, i) => ({ x: padL + (i / 23) * chartW, y: padT + chartH - (v / max) * chartH }));
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#a3a3a3';
      ctx.beginPath();
      drawSmoothLine(ctx, totalPts);
      ctx.stroke();
      const totalGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
      totalGrad.addColorStop(0, 'rgba(163,163,163,0.18)');
      totalGrad.addColorStop(1, 'rgba(163,163,163,0)');
      ctx.fillStyle = totalGrad;
      ctx.lineTo(padL + chartW, padT + chartH);
      ctx.lineTo(padL, padT + chartH);
      ctx.closePath();
      ctx.fill();

      // verified line + area
      const verifPts = verified.map((v, i) => ({ x: padL + (i / 23) * chartW, y: padT + chartH - (v / max) * chartH }));
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#22c55e';
      ctx.beginPath();
      drawSmoothLine(ctx, verifPts);
      ctx.stroke();
      const vGrad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
      vGrad.addColorStop(0, 'rgba(34,197,94,0.25)');
      vGrad.addColorStop(1, 'rgba(34,197,94,0)');
      ctx.fillStyle = vGrad;
      ctx.lineTo(padL + chartW, padT + chartH);
      ctx.lineTo(padL, padT + chartH);
      ctx.closePath();
      ctx.fill();
    }

    function renderDispositionList() {
      const list = document.getElementById('dispositionList');
      const counts = {};
      filteredData.forEach(d => { counts[d.status] = (counts[d.status]||0) + 1; });
      const sorted = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
      const max = Math.max(...Object.values(counts), 1);
      if (!sorted.length) {
        list.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;padding:8px">No dispositions yet</div>';
        return;
      }
      list.innerHTML = sorted.map(s => {
        const pct = (counts[s] / max) * 100;
        const color = COLORS[s] || '#525252';
        const label = LABELS[s] || s.replace(/_/g,' ');
        return '<div class="h-bar-row">' +
          '<div class="h-bar-label">' + label + '</div>' +
          '<div class="h-bar-track"><div class="h-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
          '<div class="h-bar-count mono">' + counts[s] + '</div>' +
        '</div>';
      }).join('');
    }

    function renderActivityFeed() {
      const feed = document.getElementById('activityFeed');
      const sub = document.getElementById('feedSubtitle');
      const recent = filteredData.slice(0, 30);
      sub.textContent = 'Showing ' + recent.length + ' of ' + filteredData.length;
      if (!recent.length) {
        feed.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;padding:12px">No activity yet</div>';
        return;
      }
      feed.innerHTML = recent.map(d => {
        const ts = d.timestamp ? new Date(d.timestamp) : null;
        const time = ts ? String(ts.getHours()).padStart(2,'0') + ':' + String(ts.getMinutes()).padStart(2,'0') + ':' + String(ts.getSeconds()).padStart(2,'0') : '--:--:--';
        const color = COLORS[d.status] || '#525252';
        const label = LABELS[d.status] || d.status;
        const phone = d.phone && d.phone.length === 10 ? '****-' + d.phone.slice(-4) : (d.phone || '—');
        const name = d.full_name || '<span style="color:var(--text-dim)">—</span>';
        return '<div class="feed-row">' +
          '<div class="feed-time mono">' + time + '</div>' +
          '<div class="feed-status-dot" style="background:' + color + '" title="' + label + '"></div>' +
          '<div class="feed-phone mono">' + phone + '</div>' +
          '<div class="feed-name">' + name + ' <span class="feed-status-label">· ' + label.toLowerCase() + '</span></div>' +
        '</div>';
      }).join('');
    }

    function updateLabel() {
      const el = document.getElementById('updatedLabel');
      if (!lastFetchTs) { el.textContent = '—'; return; }
      const sec = Math.floor((Date.now() - lastFetchTs) / 1000);
      el.textContent = sec < 60 ? 'Updated ' + sec + 's ago' : 'Updated ' + Math.floor(sec/60) + 'm ago';
    }

    function showToast(msg, success) {
      const t = document.createElement('div');
      t.className = 'toast' + (success ? ' success' : '');
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    }

    function startAutoRefresh() {
      stopAutoRefresh();
      refreshTimer = setInterval(() => { if (!paused && !document.hidden) fetchData(); }, REFRESH_INTERVAL_MS);
      countdownTimer = setInterval(updateLabel, 1000);
    }
    function stopAutoRefresh() {
      if (refreshTimer) clearInterval(refreshTimer);
      if (countdownTimer) clearInterval(countdownTimer);
    }

    function togglePause() {
      paused = !paused;
      const dot = document.getElementById('liveDot');
      const lbl = document.getElementById('liveLabel');
      const btn = document.getElementById('pauseBtn');
      if (paused) {
        dot.classList.add('paused');
        lbl.textContent = 'Paused';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>';
      } else {
        dot.classList.remove('paused');
        lbl.textContent = 'Live · auto 30s';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
        fetchData();
      }
    }

    function init() {
      document.querySelectorAll('#rangeGroup .pill').forEach(b => {
        b.addEventListener('click', () => {
          document.querySelectorAll('#rangeGroup .pill').forEach(x => x.classList.remove('active'));
          b.classList.add('active');
          currentRange = b.dataset.range;
          const cd = document.getElementById('customDate');
          cd.style.display = currentRange === 'custom' ? '' : 'none';
          document.getElementById('volumeSubtitle').textContent =
            currentRange === 'today' ? 'Today · hourly' :
            currentRange === 'yesterday' ? 'Yesterday · hourly' :
            currentRange === '7d' ? 'Last 7 days · hourly' : 'Custom date · hourly';
          if (currentRange !== 'custom' || customDate) fetchData();
        });
      });
      document.getElementById('customDate').addEventListener('change', (e) => {
        customDate = e.target.value;
        if (customDate) fetchData();
      });
      document.getElementById('statusFilter').addEventListener('change', (e) => {
        currentStatus = e.target.value;
        applyFilters();
        render();
      });
      document.getElementById('refreshBtn').addEventListener('click', fetchData);
      document.getElementById('pauseBtn').addEventListener('click', togglePause);
      document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (e.key === 'r' || e.key === 'R') fetchData();
        else if (e.key === ' ') { e.preventDefault(); togglePause(); }
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !paused) fetchData();
      });
      fetchData();
      startAutoRefresh();
    }

    if (tokenRequired) {
      document.getElementById('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') authenticate(); });
    } else {
      init();
    }
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
          // Second-ID fields for the two-step verification prompt. Additive —
          // existing consumers of full_name are unaffected. The worker falls
          // back to its DEFAULT_* values for any empty field.
          dob: contact.dob || "",
          addr1: contact.addr1 || "",
          addr2: contact.addr2 || "",
          city: contact.city || "",
          state: contact.state || "",
          zip: contact.zip || "",
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
  const callId = req.body?.call?.call_id || "";

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

  appendDispositionEntry({
    phone: phoneKey,
    status,
    disposition: getDispositionLabel(status),
    summary: summary || "",
    full_name: full_name || "",
    source: "log_verification",
    call_id: callId,
    timestamp: new Date().toISOString(),
  });

  // If call_ended arrived first and created a customer_disconnected fallback for
  // THIS SPECIFIC call, overwrite its status. Match by call_id so back-to-back
  // calls to the same phone (queue rotation) don't cross-contaminate.
  const fallbackEntry = callId
    ? dispositionLog.slice().reverse().find(
        (d) => d.phone === phoneKey && d.call_id === callId && d.status === "customer_disconnected" && d.source === "retell_call_ended"
      )
    : null;
  if (fallbackEntry) {
    fallbackEntry.status = status;
    fallbackEntry.disposition = getDispositionLabel(status);
    fallbackEntry.summary = summary || fallbackEntry.summary;
    fallbackEntry.full_name = full_name || fallbackEntry.full_name;
    fallbackEntry.source = "log_verification_late";
    stats.customerDisconnectedCount--;
    persistDispositionUpdates();
    console.log(`[VERIFICATION] ${phoneKey} (${callId}): Overwrote customer_disconnected fallback → ${getDispositionLabel(status)}`);
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

      // Try to upgrade customer_disconnected with call analysis.
      //
      // GATE BY DISCONNECT REASON — only user_hangup is eligible for upgrade.
      // inactivity:       No human spoke. Retell analyzer hallucinates confirmations.
      // voicemail_reached: Emma talked to a voicemail greeting, not a person.
      // ivr_reached:       IVR system, not a person.
      // agent_hangup:      Expected (Retell ended its own leg). Not a customer action.
      //
      // RESTRICT INFERRED STATUSES — only wrong_number and dnc are reliable.
      // verified:          Retell summary is unreliable (says "confirmed" when customer
      //                    said something vague before hanging up). 0% accuracy on edge cases.
      // third_party_end:   "not available" matches voicemails and IVR, not just real third parties.
      // consumer_busy_end: Borderline — safer to leave as customer_disconnected.
      const dr = (existing.disconnect_reason || "").toLowerCase();
      const upgradeEligible = dr === "user_hangup";

      if (existing.status === "customer_disconnected" && call.call_analysis) {
        const cs = (call.call_analysis.call_summary || "").toLowerCase();

        let upgradedTo = null;

        if (upgradeEligible) {
          if (cs.includes("wrong number") || cs.includes("wrong person")) {
            upgradedTo = "wrong_number";
            stats.wrongNumberCount++;
          } else if (
            cs.includes("do not call")
            || cs.includes("stop calling")
            || cs.includes("remove my number")
            || cs.includes("not to be called")
            || cs.includes("not to call")
            || cs.includes("don't call")
            || cs.includes("take me off")
          ) {
            upgradedTo = "dnc";
            stats.dncCount++;
          }
        }

        if (upgradedTo) {
          existing.status = upgradedTo;
          existing.disposition = getDispositionLabel(upgradedTo);
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → ${existing.disposition} (disconnect: ${dr})`);
        } else {
          existing.summary = call.call_analysis.call_summary || existing.summary;
          if (!upgradeEligible && dr) {
            console.log(`[CALL ANALYZED] ${phone}: Skipped upgrade — disconnect_reason=${dr}`);
          }
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

  const header = "timestamp_est,phone,disposition,status,summary,full_name,call_id,duration_ms,disconnect_reason,source\n";
  const rows = withStatus.map((d) =>
    [
      toEST(d.timestamp),
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