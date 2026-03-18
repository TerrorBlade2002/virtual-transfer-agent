const express = require("express");
const fs = require("fs");
const csv = require("csv-parser");

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const CSV_FILE = process.env.CSV_FILE || "./contacts.csv";
const PORT = process.env.PORT || 3000;

// Your CSV column mappings
const PHONE_COLUMNS = ["PHONE1", "PHONE2", "PHONE3", "PHONE4", "PHONE5", "PHONE6"];
const NAME_COLUMN = "FIRSTNAME";         // → Retell {{full_name}}

// ============================================================
// DISPOSITION LABELS
// Maps function status codes → human-readable disposition labels
// These are the ONLY valid dispositions in the system.
// ============================================================
const DISPOSITION_LABELS = {
  verified:              "Full Name Verified - Right Party",
  wrong_number:          "Wrong Number",
  third_party_end:       "Third party end of conversation",
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

// 4. Counters
let stats = {
  webhookCalls: 0,
  webhookHits: 0,
  webhookMisses: 0,
  lastCall: null,
  verificationsLogged: 0,
  verifiedCount: 0,
  wrongNumberCount: 0,
  thirdPartyEndCount: 0,
  dncCount: 0,
  customerWantsHumanCount: 0,
  otherCount: 0,
  customerDisconnectedCount: 0,
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
    case "dnc": stats.dncCount++; break;
    case "customer_wants_human": stats.customerWantsHumanCount++; break;
    case "other": stats.otherCount++; break;
    case "customer_disconnected": stats.customerDisconnectedCount++; break;
  }
}

// ============================================================
// LOAD CONTACTS FROM ./contacts.csv
// ============================================================
function loadContacts() {
  return new Promise((resolve, reject) => {
    let records = 0;
    let phoneEntries = 0;

    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on("data", (row) => {
        records++;
        const name = (row[NAME_COLUMN] || "").trim();

        for (const col of PHONE_COLUMNS) {
          const rawPhone = (row[col] || "").trim();
          if (rawPhone) {
            const phone = normalizePhone(rawPhone);
            if (phone.length === 10) {
              contacts.set(phone, {
                full_name: name,
                raw_record: {
                  full_name_original: (row["FULL_NAME"] || "").trim(),
                  account: (row["ACCOUNT"] || "").trim(),
                  masteracct: (row["MASTERACCT"] || "").trim(),
                  cltrefno: (row["CLTREFNO"] || "").trim(),
                },
              });
              phoneEntries++;
            }
          }
        }
      })
      .on("end", () => {
        console.log(`Loaded ${records} records → ${phoneEntries} phone entries from ${CSV_FILE}`);
        resolve();
      })
      .on("error", reject);
  });
}

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
//   dnc, customer_wants_human, other
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
// All responses HTTP 200 — every call goes to Hunt Group.
// ============================================================
app.get("/verification-status", (req, res) => {
  const phone = req.query.phone || "";
  const normalized = normalizePhone(phone);
  const result = getVerification(normalized);

  if (result) {
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

    console.log(`[TCN LOOKUP] ${normalized}: ${getDispositionLabel(result.status)}`);
    return res.json({
      found: true,
      status: result.status,
      disposition: getDispositionLabel(result.status),
      whisper,
      summary: result.summary,
      full_name: result.full_name,
    });
  }

  console.log(`[TCN LOOKUP] ${normalized}: NOT FOUND`);
  return res.json({
    found: false,
    status: "unknown",
    disposition: "Unknown",
    whisper: "VTA — No verification data. Verify manually.",
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

        if (cs.includes("wrong number") || cs.includes("wrong person")) {
          existing.status = "wrong_number";
          existing.disposition = getDispositionLabel("wrong_number");
          existing.summary = `Inferred: ${call.call_analysis.call_summary || ""}`;
          stats.customerDisconnectedCount--;
          stats.wrongNumberCount++;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded → Wrong Number`);
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
    app.listen(PORT, () => {
      console.log(`\nVTA Webhook running on port ${PORT}`);
      console.log(`Phone entries indexed: ${contacts.size}`);
      console.log(`\nValid dispositions:`);
      for (const [code, label] of Object.entries(DISPOSITION_LABELS)) {
        console.log(`  ${code} → ${label}`);
      }
      console.log(`\nEndpoints:`);
      console.log(`  POST /retell-webhook        → Retell inbound (dynamic vars)`);
      console.log(`  POST /log-verification      → Retell custom fn (verification result)`);
      console.log(`  GET  /verification-status    → TCN reads verification result`);
      console.log(`  POST /retell-call-ended      → Retell call ended/analyzed webhook`);
      console.log(`  GET  /dispositions           → View dispositions (JSON)`);
      console.log(`  GET  /dispositions/csv       → Download dispositions (CSV)`);
      console.log(`  GET  /health                 → Health check`);
    });
  })
  .catch((err) => {
    console.error("Failed to load contacts:", err);
    process.exit(1);
  });