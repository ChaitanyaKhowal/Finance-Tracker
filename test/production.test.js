import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidCalendarDate,
  fmtDate,
  deriveDateParts,
} from "../src/utils/date.js";

import {
  safeStorage,
  loadUserTransactions,
  saveUserTransactions,
  clearUserCache,
  clearLegacyStorage,
  STORAGE_KEY,
} from "../src/utils/storage.js";

import {
  importRowsToTransactions,
  deduplicateTransactions,
  executeChunkedUpsert,
  makeTxnSignature,
} from "../src/utils/csv.js";

// ============================================================================
// 1. DATE VALIDATION & TIMEZONE IMMUNITY
// ============================================================================
test("isValidCalendarDate rejects impossible calendar dates", () => {
  assert.strictEqual(isValidCalendarDate("2026-02-31"), false);
  assert.strictEqual(isValidCalendarDate("2026-04-31"), false);
  assert.strictEqual(isValidCalendarDate("2025-02-29"), false); // 2025 not a leap year
  assert.strictEqual(isValidCalendarDate("2026-13-01"), false); // month 13
  assert.strictEqual(isValidCalendarDate("2026-00-10"), false); // month 0
  assert.strictEqual(isValidCalendarDate(""), false);
  assert.strictEqual(isValidCalendarDate(null), false);
  assert.strictEqual(isValidCalendarDate("not-a-date"), false);
});

test("isValidCalendarDate accepts valid dates and leap years", () => {
  assert.strictEqual(isValidCalendarDate("2024-02-29"), true); // 2024 leap year
  assert.strictEqual(isValidCalendarDate("2025-02-28"), true);
  assert.strictEqual(isValidCalendarDate("2026-10-20"), true);
  assert.strictEqual(isValidCalendarDate("2026-12-31"), true);
});

test("fmtDate formats dates consistently without timezone shift", () => {
  assert.strictEqual(fmtDate("2026-10-20"), "20 Oct 2026");
  assert.strictEqual(fmtDate("2026-01-01"), "01 Jan 2026");
  assert.strictEqual(fmtDate("2026-12-31"), "31 Dec 2026");
  assert.strictEqual(fmtDate("invalid"), "invalid");
});

test("deriveDateParts parses month and year directly from string", () => {
  assert.deepStrictEqual(deriveDateParts("2026-10-20"), { month: 10, year: 2026 });
  assert.deepStrictEqual(deriveDateParts("2026-02-28"), { month: 2, year: 2026 });
  assert.deepStrictEqual(deriveDateParts("invalid"), { month: null, year: null });
});

test("importRowsToTransactions normalizes valid rows and captures errors", () => {
  const rows = [
    { Date: "2026-10-20", Amount: "1,500.50", Type: "Expense", Category: "Food", "Payment Mode": "UPI", description: "Lunch" },
    { Date: "2026-02-31", Amount: "200", Type: "Expense", Category: "Food" }, // invalid date
    { Date: "2026-10-21", Amount: "-50", Type: "Income", Category: "Salary" }, // negative amount
  ];

  const { valid, errors } = importRowsToTransactions(rows);
  assert.strictEqual(valid.length, 1);
  assert.strictEqual(valid[0].amount, 1500.50);
  assert.strictEqual(valid[0].date, "2026-10-20");
  assert.strictEqual(errors.length, 2);
});

// ============================================================================
// 2. CSV DEDUPLICATION & REPEAT TRANSACTION SAFETY
// ============================================================================
test("deduplicateTransactions preserves repeated legitimate same-day purchases in same CSV", () => {
  const existingLedger = [];
  const incomingCSVRows = [
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
  ];

  const result = deduplicateTransactions(incomingCSVRows, existingLedger);
  assert.strictEqual(result.toAdd.length, 2, "Both distinct coffees should be accepted");
  assert.strictEqual(result.duplicatesCount, 0, "No duplicate dropped");
  assert.notStrictEqual(result.toAdd[0].id, result.toAdd[1].id, "Assigned IDs must be unique");
});

test("deduplicateTransactions handles re-imports of the exact same CSV idempotently", () => {
  const existingLedger = [
    { id: "tx_c1", date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { id: "tx_c2", date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
  ];

  const reimportedCSV = [
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
  ];

  const result = deduplicateTransactions(reimportedCSV, existingLedger);
  assert.strictEqual(result.toAdd.length, 0, "All rows in re-imported CSV should be skipped");
  assert.strictEqual(result.duplicatesCount, 2, "2 duplicates detected");
});

test("deduplicateTransactions imports 3rd purchase when ledger already has 2 identical purchases", () => {
  const existingLedger = [
    { id: "tx_c1", date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { id: "tx_c2", date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
  ];

  const updatedCSV = [
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" },
    { date: "2026-10-20", description: "Coffee", category: "Food", type: "expense", amount: 150, paymentMode: "UPI" }, // 3rd coffee
  ];

  const result = deduplicateTransactions(updatedCSV, existingLedger);
  assert.strictEqual(result.toAdd.length, 1, "Only the 3rd new coffee should be added");
  assert.strictEqual(result.duplicatesCount, 2, "First 2 coffees skipped");
});

test("deduplicateTransactions honors explicit stable transaction IDs", () => {
  const existingLedger = [
    { id: "BANK_REF_001", date: "2026-10-20", description: "Store", category: "Shopping", type: "expense", amount: 500, paymentMode: "Online" }
  ];

  const incomingWithIds = [
    // Duplicate ID
    { id: "BANK_REF_001", date: "2026-10-20", description: "Store", category: "Shopping", type: "expense", amount: 500, paymentMode: "Online" },
    // New ID with same content
    { id: "BANK_REF_002", date: "2026-10-20", description: "Store", category: "Shopping", type: "expense", amount: 500, paymentMode: "Online" },
  ];

  const result = deduplicateTransactions(incomingWithIds, existingLedger);
  assert.strictEqual(result.toAdd.length, 1);
  assert.strictEqual(result.toAdd[0].id, "BANK_REF_002");
  assert.strictEqual(result.duplicatesCount, 1);
});

test("makeTxnSignature includes notes to avoid dropping entries with different notes", () => {
  const t1 = { date: "2026-10-20", type: "expense", category: "Food", amount: 100, description: "Lunch", paymentMode: "Cash", notes: "Meeting 1" };
  const t2 = { date: "2026-10-20", type: "expense", category: "Food", amount: 100, description: "Lunch", paymentMode: "Cash", notes: "Meeting 2" };
  assert.notStrictEqual(makeTxnSignature(t1), makeTxnSignature(t2));
});

// ============================================================================
// 3. CHUNKED IMPORT FAILURE REPORTING (MOCKED SUPABASE)
// ============================================================================
test("executeChunkedUpsert handles complete success", async () => {
  const mockRows = Array.from({ length: 450 }, (_, i) => ({ id: `row_${i}`, user_id: "u1", amount: 10 }));
  const mockSupabase = {
    from: () => ({
      upsert: async () => ({ error: null })
    })
  };

  const res = await executeChunkedUpsert(mockSupabase, mockRows, 200);
  assert.strictEqual(res.isCompleteSuccess, true);
  assert.strictEqual(res.succeeded.length, 450);
  assert.strictEqual(res.failed.length, 0);
  assert.strictEqual(res.error, null);
});

test("executeChunkedUpsert accurately reports partial failure without claiming rollback", async () => {
  const mockRows = Array.from({ length: 500 }, (_, i) => ({ id: `row_${i}`, user_id: "u1", amount: 10 }));
  let callCount = 0;
  const mockSupabase = {
    from: () => ({
      upsert: async () => {
        callCount++;
        if (callCount === 2) {
          // Chunk 1 (0-199) succeeded; Chunk 2 (200-399) fails
          return { error: { message: "Database timeout on chunk 2" } };
        }
        return { error: null };
      }
    })
  };

  const res = await executeChunkedUpsert(mockSupabase, mockRows, 200);
  assert.strictEqual(res.isPartial, true);
  assert.strictEqual(res.succeeded.length, 200, "First chunk succeeded");
  assert.strictEqual(res.failed.length, 300, "Failed chunk + remaining chunks counted as failed");
  assert.strictEqual(res.error.message, "Database timeout on chunk 2");
});

test("executeChunkedUpsert handles complete failure", async () => {
  const mockRows = [{ id: "r1" }, { id: "r2" }];
  const mockSupabase = {
    from: () => ({
      upsert: async () => ({ error: { message: "Network offline" } })
    })
  };

  const res = await executeChunkedUpsert(mockSupabase, mockRows, 200);
  assert.strictEqual(res.isCompleteFailure, true);
  assert.strictEqual(res.succeeded.length, 0);
  assert.strictEqual(res.failed.length, 2);
});

// ============================================================================
// 4. USER CACHE ISOLATION & LOGOUT PURGE
// ============================================================================
test("loadUserTransactions and saveUserTransactions enforce strict user scoping", () => {
  const userA = "user_alpha_uuid";
  const userB = "user_beta_uuid";

  const txnsA = [{ id: "tx_a1", date: "2026-10-01", amount: 1000, description: "Salary", type: "income" }];

  saveUserTransactions(userA, txnsA);

  // User B loads transactions
  const loadedB = loadUserTransactions(userB);
  assert.deepStrictEqual(loadedB, [], "User B should not see User A's data");

  // Unauthenticated loads
  const loadedUnauth = loadUserTransactions(null);
  assert.deepStrictEqual(loadedUnauth, [], "Unauthenticated access should return []");

  // User A loads own data
  const loadedA = loadUserTransactions(userA);
  assert.strictEqual(loadedA.length, 1);
  assert.strictEqual(loadedA[0].id, "tx_a1");

  // User A logs out -> clearUserCache
  clearUserCache(userA);
  clearLegacyStorage();

  const loadedAAfterLogout = loadUserTransactions(userA);
  assert.deepStrictEqual(loadedAAfterLogout, [], "Cache should be empty after logout");
  assert.strictEqual(safeStorage.getItem(STORAGE_KEY), null, "Legacy storage should be null");
});
