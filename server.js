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
  failedCount: 0,
  humanRequestedCount: 0,
  thirdPartyCount: 0,
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
// ROUTE 1: RETELL INBOUND WEBHOOK (your original — unchanged)
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
// Retell agent calls this DURING the call, BEFORE end_call.
// Stores the result so TCN can read it after Linkback completes.
// ============================================================
app.post("/log-verification", (req, res) => {
  console.log(`[VERIFICATION] Full payload:`, JSON.stringify(req.body, null, 2));

  const args = req.body?.args || req.body || {};
  const { status, summary, full_name } = args;

  // Try to get phone from multiple sources — don't fail if missing
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

  // Store verification — use phone if available, "unknown" if not
  const phoneKey = (normalized && normalized.length === 10) ? normalized : "unknown";

  if (phoneKey !== "unknown") {
    storeVerification(phoneKey, {
      status,
      summary: summary || "",
      full_name: full_name || "",
    });
  }

  stats.verificationsLogged++;
  if (status === "verified") stats.verifiedCount++;
  else if (status === "failed") stats.failedCount++;
  else if (status === "customer_wants_human") stats.humanRequestedCount++;
  else if (status === "third_party") stats.thirdPartyCount++;

  dispositionLog.push({
    phone: phoneKey,
    status,
    summary: summary || "",
    full_name: full_name || "",
    timestamp: new Date().toISOString(),
  });

  console.log(`[VERIFICATION] ${phoneKey}: ${status} — ${summary || ""}`);

  // Race condition fix: if call_ended arrived first and created a
  // "customer_disconnected" fallback for this phone, overwrite it
  // with the real verification status.
  const fallbackEntry = dispositionLog.slice().reverse().find(
    (d) => d.phone === phoneKey && d.status === "customer_disconnected"
  );
  if (fallbackEntry) {
    fallbackEntry.status = status;
    fallbackEntry.summary = summary || fallbackEntry.summary;
    fallbackEntry.full_name = full_name || fallbackEntry.full_name;
    fallbackEntry.source = "log_verification_late";
    stats.customerDisconnectedCount--;
    console.log(`[VERIFICATION] Overwrote customer_disconnected fallback for ${phoneKey} → ${status}`);
  }

  return res.json({ result: `Logged: ${status}` });
});

// ============================================================
// ROUTE 3: TCN — GET VERIFICATION STATUS
//
// TCN Custom Integration JS calls this after Linkback Action OK.
// Returns status + whisper text + disposition code.
// ============================================================
app.get("/verification-status", (req, res) => {
  const phone = req.query.phone || "";
  const normalized = normalizePhone(phone);
  const result = getVerification(normalized);

  if (result) {
    let whisper = "";
    let disposition = "";

    switch (result.status) {
      case "verified":
        whisper = `Verified call. Customer ${result.full_name || "unknown"} confirmed identity.`;
        disposition = "VTA_VERIFIED";
        break;
      case "customer_wants_human":
        whisper = `Customer requested live agent. Verify manually.`;
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
      case "customer_disconnected":
        whisper = `Customer hung up before verification. Verify manually.`;
        disposition = "VTA_CUSTOMER_DISCONNECTED";
        break;
      default:
        whisper = `VTA processed. Status: ${result.status}`;
        disposition = "VTA_UNKNOWN";
    }

    console.log(`[TCN LOOKUP] ${normalized}: ${result.status}`);
    return res.json({ found: true, status: result.status, disposition, whisper, summary: result.summary, full_name: result.full_name });
  }

  console.log(`[TCN LOOKUP] ${normalized}: NOT FOUND`);
  return res.json({ found: false, status: "unknown", disposition: "VTA_NO_RESULT", whisper: "VTA call. Verification unknown. Verify manually." });
});

// ============================================================
// ROUTE 4: RETELL CALL-ENDED WEBHOOK
//
// Set as Retell Account-Level Webhook.
// Captures transcripts + post-call analysis.
//
// KEY LOGIC: If call_ended fires and NO verification result
// exists for this phone, it means the customer hung up before
// Emma could call log_verification. We create a fallback
// "customer_disconnected" entry so no call is lost.
// ============================================================
app.post("/retell-call-ended", (req, res) => {
  const { event, call } = req.body || {};

  if (event === "call_ended" && call) {
    const phone = normalizePhone(call.from_number || call.to_number || "");
    const callId = call.call_id || "";
    const durationMs = call.duration_ms || 0;
    const disconnectReason = call.disconnection_reason || "";

    console.log(`[CALL ENDED] ${phone} | ${durationMs}ms | ${disconnectReason}`);

    // Check: did log_verification already fire for this phone?
    const hasVerification = phone.length === 10 && getVerification(phone);

    // Also check if a log_verification disposition entry exists
    // (covers the case where phone was "unknown" in verification but exists here)
    const hasDispositionEntry = dispositionLog.some(
      (d) => d.phone === phone
        && d.source !== "retell_call_ended"
        && d.status !== "customer_disconnected"
        && (Date.now() - new Date(d.timestamp).getTime()) < VERIFICATION_TTL
    );

    if (hasVerification || hasDispositionEntry) {
      // Normal path: log_verification already fired.
      // Just add the call metadata as an enrichment entry.
      dispositionLog.push({
        phone,
        call_id: callId,
        duration_ms: durationMs,
        disconnect_reason: disconnectReason,
        source: "retell_call_ended",
        timestamp: new Date().toISOString(),
      });
      console.log(`[CALL ENDED] ${phone}: Verification already logged — adding call metadata`);
    } else {
      // FALLBACK: Customer hung up before log_verification fired.
      // Create a disposition entry so this call isn't lost.
      const contactInfo = phone.length === 10 ? contacts.get(phone) : null;

      dispositionLog.push({
        phone: phone || "unknown",
        call_id: callId,
        status: "customer_disconnected",
        summary: `Customer disconnected before verification completed. Reason: ${disconnectReason}`,
        full_name: contactInfo ? contactInfo.full_name : "",
        duration_ms: durationMs,
        disconnect_reason: disconnectReason,
        source: "retell_call_ended",
        timestamp: new Date().toISOString(),
      });

      // Also store in verificationResults so TCN Data Dip can read it
      // (in case TCN's linkback is still in progress)
      if (phone.length === 10) {
        storeVerification(phone, {
          status: "customer_disconnected",
          summary: `Customer hung up. Reason: ${disconnectReason}`,
          full_name: contactInfo ? contactInfo.full_name : "",
        });
      }

      stats.customerDisconnectedCount++;
      console.log(`[CALL ENDED] ${phone}: ⚠ No verification found — logged as customer_disconnected`);
    }
  }

  if (event === "call_analyzed" && call) {
    const phone = normalizePhone(call.from_number || call.to_number || "");
    const callId = call.call_id || "";

    // Find the existing entry for this call_id and enrich it
    const existing = dispositionLog.slice().reverse().find((d) => d.call_id === callId);
    if (existing) {
      existing.analysis = call.call_analysis;
      existing.transcript = call.transcript;

      // If this was a customer_disconnected fallback, try to extract
      // a better status from Retell's call analysis
      if (existing.status === "customer_disconnected" && call.call_analysis) {
        const sentiment = (call.call_analysis.user_sentiment || "").toLowerCase();
        const callSummary = (call.call_analysis.call_summary || "").toLowerCase();

        // Retell's analysis can tell us what likely happened
        if (callSummary.includes("wrong person") || callSummary.includes("third party") || callSummary.includes("not available")) {
          existing.status = "third_party_inferred";
          existing.summary = `Inferred from call analysis: ${call.call_analysis.call_summary || ""}`;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded customer_disconnected → third_party_inferred`);
        } else if (callSummary.includes("refused") || callSummary.includes("would not verify")) {
          existing.status = "failed_inferred";
          existing.summary = `Inferred from call analysis: ${call.call_analysis.call_summary || ""}`;
          console.log(`[CALL ANALYZED] ${phone}: Upgraded customer_disconnected → failed_inferred`);
        } else {
          // Keep customer_disconnected but attach the summary
          existing.summary = call.call_analysis.call_summary || existing.summary;
          console.log(`[CALL ANALYZED] ${phone}: Enriched customer_disconnected with analysis`);
        }
      } else {
        console.log(`[CALL ANALYZED] ${phone}: Enriched existing entry with transcript`);
      }
    } else {
      // No matching call_id — create a standalone entry
      dispositionLog.push({
        phone,
        call_id: callId,
        analysis: call.call_analysis,
        transcript: call.transcript,
        source: "retell_call_analyzed",
        timestamp: new Date().toISOString(),
      });
      console.log(`[CALL ANALYZED] ${phone}: No matching call_ended entry — created standalone`);
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
  let results = dispositionLog.slice().reverse();
  if (statusFilter) results = results.filter((d) => d.status === statusFilter);
  res.json({ total: dispositionLog.length, showing: Math.min(results.length, limit), dispositions: results.slice(0, limit) });
});

app.get("/dispositions/csv", (req, res) => {
  const header = "timestamp,phone,status,summary,full_name,call_id,duration_ms,disconnect_reason,source\n";
  const rows = dispositionLog.map((d) =>
    `${d.timestamp || ""},${d.phone || ""},${d.status || ""},${(d.summary || "").replace(/,/g, ";")},${(d.full_name || "").replace(/,/g, ";")},${d.call_id || ""},${d.duration_ms || ""},${d.disconnect_reason || ""},${d.source || ""}`
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
    totalDispositions: dispositionLog.length,
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
      console.log(`\nEndpoints:`);
      console.log(`  POST /retell-webhook        → Retell inbound (dynamic vars)`);
      console.log(`  POST /log-verification      → Retell custom fn (verification result)`);
      console.log(`  GET  /verification-status    → TCN reads verification result`);
      console.log(`  POST /retell-call-ended      → Retell call ended/analyzed webhook`);
      console.log(`  GET  /dispositions           → View dispositions`);
      console.log(`  GET  /dispositions/csv       → Export dispositions CSV`);
      console.log(`  GET  /health                 → Health check`);
    });
  })
  .catch((err) => {
    console.error("Failed to load contacts:", err);
    process.exit(1);
  });