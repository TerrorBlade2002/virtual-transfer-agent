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
const ACCOUNT_COLUMN = "MASTERACCT";     // → Retell {{ssn_last_two_digit}}

// ============================================================
// CONTACT DATA STORE
// Maps: phone (last 10 digits) → { full_name, ssn_last_two_digit }
// Each record creates multiple entries (one per phone number)
// ============================================================
const contacts = new Map();

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return digits.slice(-10);
}

function loadContacts() {
  return new Promise((resolve, reject) => {
    let records = 0;
    let phoneEntries = 0;

    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on("data", (row) => {
        records++;
        const name = (row[NAME_COLUMN] || "").trim();
        const account = (row[ACCOUNT_COLUMN] || "").trim();

        // Index this record under every non-empty phone number
        for (const col of PHONE_COLUMNS) {
          const rawPhone = (row[col] || "").trim();
          if (rawPhone) {
            const phone = normalizePhone(rawPhone);
            if (phone.length === 10) {
              contacts.set(phone, {
                full_name: name,
                ssn_last_two_digit: account,
                raw_record: {
                  full_name_original: (row["FULL_NAME"] || "").trim(),
                  account: (row["ACCOUNT"] || "").trim(),
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
// RETELL INBOUND WEBHOOK
// ============================================================
app.post("/retell-webhook", (req, res) => {
  console.log("\n=== RETELL INBOUND WEBHOOK ===");
  console.log("Timestamp:", new Date().toISOString());
  console.log("Payload:", JSON.stringify(req.body, null, 2));

  const fromNumber = req.body?.call_inbound?.from_number || "";
  const normalizedFrom = normalizePhone(fromNumber);

  console.log(`Lookup: ${fromNumber} → normalized: ${normalizedFrom}`);

  const contact = contacts.get(normalizedFrom);

  if (contact) {
    console.log(`✓ FOUND: ${contact.full_name} | MASTERACCT: ${contact.ssn_last_two_digit}`);

    return res.json({
      call_inbound: {
        dynamic_variables: {
          full_name: contact.full_name,
          ssn_last_two_digit: contact.ssn_last_two_digit,
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

  console.log(`✗ NOT FOUND for ${normalizedFrom}`);

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

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    contacts_loaded: contacts.size,
    uptime: process.uptime(),
  });
});

// ============================================================
// STARTUP
// ============================================================
loadContacts()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\nRetell VTA Webhook running on port ${PORT}`);
      console.log(`Webhook URL: http://localhost:${PORT}/retell-webhook`);
      console.log(`Health: http://localhost:${PORT}/health`);
      console.log(`Phone entries indexed: ${contacts.size}`);
    });
  })
  .catch((err) => {
    console.error("Failed to load contacts:", err);
    process.exit(1);
  });
