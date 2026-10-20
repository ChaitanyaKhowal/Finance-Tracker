import { isValidCalendarDate, deriveDateParts } from "./date.js";

export const INCOME_CATEGORIES = ["Salary", "Freelancing", "Business", "Other"];
export const EXPENSE_CATEGORIES = [
  "Food", "Rent", "Transport", "Entertainment", "Shopping", "Bills",
  "Health", "Misc", "Debt", "Investment", "Saved", "Home", "Travel",
  "Medical", "Education", "Family", "Other"
];
export const PAYMENT_MODES = ["Cash", "UPI", "Online", "Bank Transfer", "Debit Card", "Credit Card"];

export const CSV_COLUMNS = [
  "date", "description", "category", "type", "amount",
  "paymentMode", "notes", "month", "year",
];

export const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function normalizeTransaction(t, { touch = false } = {}) {
  const { month, year } = deriveDateParts(t.date);
  const now = new Date().toISOString();
  return {
    id: t.id || uid(),
    date: t.date,
    description: (t.description || "").trim(),
    category: t.category || "Other",
    type: t.type === "income" ? "income" : "expense",
    amount: Number.isFinite(t.amount) ? t.amount : parseFloat(t.amount) || 0,
    paymentMode:
      PAYMENT_MODES.find(
        (m) => m.toLowerCase() === (t.paymentMode || "").trim().toLowerCase()
      ) || "Cash",
    notes: (t.notes || "").trim(),
    month,
    year,
    createdAt: t.createdAt || now,
    updatedAt: touch ? now : t.updatedAt || now,
  };
}

export function makeTxnSignature(t) {
  const amt = Math.abs(Number(t.amount) || 0).toFixed(2);
  const desc = (t.description || "").trim().toLowerCase();
  const cat = (t.category || "").trim().toLowerCase();
  const type = (t.type || "").trim().toLowerCase();
  const mode = (t.paymentMode || "").trim().toLowerCase();
  const notes = (t.notes || "").trim().toLowerCase();
  return `${t.date}|${type}|${cat}|${amt}|${desc}|${mode}|${notes}`;
}

/**
 * Normalizes raw parsed CSV rows into valid transaction candidates or error records.
 * Enforces calendar date validity and positive numbers.
 */
export function importRowsToTransactions(rows) {
  const valid = [];
  const errors = [];

  rows.forEach((row, idx) => {
    const rowNum = idx + 2; // +2: header row + 1-indexing

    const rawDate = (row.date || row.Date || "").trim();
    let normalizedDate = rawDate;
    if (/^\d{2}-\d{2}-\d{4}$/.test(rawDate)) {
      const [dd, mm, yyyy] = rawDate.split("-");
      normalizedDate = `${yyyy}-${mm}-${dd}`;
    }

    const rawType = String(row.type || row.Type || "").trim().toLowerCase();
    const rawAmount = String(row.amount || row.Amount || "")
      .replace(/₹/g, "")
      .replace(/,/g, "")
      .trim();

    const rawPaymentMode = (
      row.payment_mode ||
      row.paymentMode ||
      row["Payment Mode"] ||
      row["payment mode"] ||
      row["Payment Method"] ||
      row["payment method"] ||
      "Cash"
    ).trim();

    const matchedPaymentMode = PAYMENT_MODES.find(
      (m) => m.toLowerCase() === rawPaymentMode.toLowerCase()
    );
    const paymentMode = matchedPaymentMode || "Cash";

    const dateOk = isValidCalendarDate(normalizedDate);
    const amountNum = parseFloat(rawAmount);
    const typeOk = rawType === "income" || rawType === "expense";

    if (!dateOk) {
      return errors.push({
        row: rowNum,
        reason: "Invalid or impossible calendar date (expected valid YYYY-MM-DD)",
      });
    }

    let description = (row.description || "").trim();
    if (!description) {
      description = (row.category || "").trim()
        ? `${row.category.trim()} ${rawType === "income" ? "Income" : "Expense"}`
        : "Untitled Transaction";
    }

    if (!typeOk) {
      return errors.push({ row: rowNum, reason: 'Type must be "income" or "expense"' });
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return errors.push({ row: rowNum, reason: "Amount must be a positive number" });
    }

    const fallbackCategories = rawType === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    let rawCategory = (row.category || "").trim();
    if (rawCategory.toLowerCase() === "bill") rawCategory = "Bills";
    const matchedCategory = fallbackCategories.find(
      (c) => c.toLowerCase() === rawCategory.toLowerCase()
    );
    const category = matchedCategory || "Other";

    valid.push(
      normalizeTransaction({
        id: row.id ? String(row.id).trim() : undefined,
        date: normalizedDate,
        description,
        category,
        type: rawType,
        amount: amountNum,
        paymentMode,
        notes: row.notes,
      })
    );
  });

  return { valid, errors };
}

/**
 * Deduplicates candidate transactions against existing ledger.
 * - If an explicit ID is present: strictly matches on ID.
 * - If no ID is present: counts occurrences of identical signatures in both
 *   the existing ledger and the incoming import to prevent dropping legitimate
 *   repeat purchases (e.g. two coffees on the same day).
 */
export function deduplicateTransactions(incomingRows, existingTransactions = []) {
  const existingIds = new Set(
    existingTransactions
      .filter((t) => t && t.id)
      .map((t) => String(t.id))
  );

  // Count occurrences of each signature in existing ledger
  const existingSigCounts = new Map();
  for (const t of existingTransactions) {
    const sig = makeTxnSignature(t);
    existingSigCounts.set(sig, (existingSigCounts.get(sig) || 0) + 1);
  }

  const incomingSigCounts = new Map();
  const toAdd = [];
  let duplicatesCount = 0;

  for (const item of incomingRows) {
    // 1. Stable explicit ID match
    if (item.id && existingIds.has(String(item.id))) {
      duplicatesCount++;
      continue;
    }

    if (item.id && !existingIds.has(String(item.id))) {
      // Has explicit new ID not in database -> accept
      existingIds.add(String(item.id));
      toAdd.push({
        ...item,
        id: String(item.id),
      });
      continue;
    }

    // 2. ID absent: Cardinality-aware signature deduplication
    const sig = makeTxnSignature(item);
    const incomingOcc = (incomingSigCounts.get(sig) || 0) + 1;
    incomingSigCounts.set(sig, incomingOcc);

    const existingCount = existingSigCounts.get(sig) || 0;
    if (incomingOcc <= existingCount) {
      // This occurrence already exists in the ledger -> duplicate
      duplicatesCount++;
    } else {
      // Exceeds existing occurrences -> genuine repeat or new transaction!
      const finalItem = {
        ...item,
        id: uid(),
      };
      existingIds.add(String(finalItem.id));
      toAdd.push(finalItem);
    }
  }

  return {
    toAdd,
    duplicatesCount,
  };
}

/**
 * Executes a chunked upsert to Supabase in batches of chunkSize.
 * Accurately reports succeeded vs failed rows.
 */
export async function executeChunkedUpsert(supabaseClient, dbRows, chunkSize = 200) {
  const succeeded = [];
  const failed = [];
  let error = null;

  for (let i = 0; i < dbRows.length; i += chunkSize) {
    const chunk = dbRows.slice(i, i + chunkSize);
    const { error: upsertErr } = await supabaseClient
      .from("transactions")
      .upsert(chunk, { onConflict: "id,user_id" });

    if (upsertErr) {
      error = upsertErr;
      failed.push(...chunk);
      // Any remaining chunks are also marked as failed
      for (let j = i + chunkSize; j < dbRows.length; j += chunkSize) {
        failed.push(...dbRows.slice(j, j + chunkSize));
      }
      break;
    } else {
      succeeded.push(...chunk);
    }
  }

  return {
    succeeded,
    failed,
    error,
    isPartial: succeeded.length > 0 && failed.length > 0,
    isCompleteFailure: succeeded.length === 0 && failed.length > 0,
    isCompleteSuccess: failed.length === 0,
  };
}
