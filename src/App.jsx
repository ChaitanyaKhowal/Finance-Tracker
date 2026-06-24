import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Plus, Search, ArrowUpRight, ArrowDownRight, Wallet, PiggyBank,
  TrendingUp, TrendingDown, Pencil, Trash2, X, Moon, Sun,
  ChevronDown, Filter, ReceiptText, Download, Upload,
  CalendarClock, CalendarDays, ChevronLeft, ChevronRight, BarChart3,
  Minus, Tag, Receipt, ListChecks, SlidersHorizontal,
  LogOut, Lock, User, Eye, EyeOff, ShieldCheck, AlertTriangle
} from "lucide-react";

/* ---------------------------------------------------------------
   CONFIG
----------------------------------------------------------------*/

const INCOME_CATEGORIES = ["Salary", "Freelancing", "Business", "Other"];
const EXPENSE_CATEGORIES = ["Food", "Rent", "Transport", "Entertainment", "Shopping", "Bills", "Health", "Misc", "Debt", "Investment", "Saved", "Home", "Travel", "Medical", "Education", "Family", "Other"];
const PAYMENT_MODES = ["Cash", "UPI", "Online", "Bank Transfer", "Debit Card", "Credit Card"];

/* Data model (future-proof for budgets / analytics / yearly reports):
   {
     id: string,
     date: "YYYY-MM-DD",
     description: string,
     category: string,
     type: "income" | "expense",
     amount: number,
     paymentMode: "Cash" | "UPI" | "Bank Transfer" | "Debit Card" | "Credit Card",
     notes: string,            // optional, "" if none
     month: number,            // 1-12, derived from date — indexed for fast monthly aggregation
     year: number,             // derived from date — indexed for fast yearly aggregation
     createdAt: ISO timestamp, // audit trail
     updatedAt: ISO timestamt  // audit trail
   }
*/

const CATEGORY_STYLES = {
  Salary: { bg: "rgba(74,222,128,0.14)", fg: "#4ADE80" },
  Freelancing: { bg: "rgba(56,189,248,0.14)", fg: "#38BDF8" },
  Business: { bg: "rgba(167,139,250,0.14)", fg: "#A78BFA" },
  Food: { bg: "rgba(251,146,60,0.14)", fg: "#FB923C" },
  Travel: { bg: "rgba(45,212,191,0.14)", fg: "#2DD4BF" },
  Shopping: { bg: "rgba(244,114,182,0.14)", fg: "#F472B6" },
  Medical: { bg: "rgba(248,113,113,0.14)", fg: "#F87171" },
  Education: { bg: "rgba(96,165,250,0.14)", fg: "#60A5FA" },
  Family: { bg: "rgba(250,204,21,0.14)", fg: "#FACC15" },
  Other: { bg: "rgba(148,163,184,0.16)", fg: "#94A3B8" },
};

const STORAGE_KEY = "pft_transactions_v1";
const THEME_KEY = "pft_theme_v1";

/* In-browser deployments (Vite/CRA/Next, etc.) have real window.localStorage.
   The Claude.ai artifact preview sandbox blocks it, so we fall back to an
   in-memory store with the exact same API — drop this file into a real
   project and it persists automatically with zero changes. */
const memoryStore = {};
const safeStorage = (() => {
  try {
    const testKey = "__pft_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return window.localStorage;
  } catch (e) {
    return {
      getItem: (k) => (k in memoryStore ? memoryStore[k] : null),
      setItem: (k, v) => {
        memoryStore[k] = String(v);
      },
      removeItem: (k) => {
        delete memoryStore[k];
      },
    };
  }
})();

const currency = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

const fmtDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/* ---------------------------------------------------------------
   AUTHENTICATION MODULE
   ---------------------------------------------------------------
   IMPORTANT, HONEST CAVEAT: this is a privacy screen, not real
   security. Credentials and the password hash live in this browser's
   localStorage, in plain JSON. Anyone with access to the device and
   dev tools (or just localStorage.getItem) can read it directly —
   client-side storage cannot be made secure against the device's own
   user. What this DOES achieve: the financial data isn't shown to
   someone who casually opens the page, and a password is never
   stored in plaintext, only as a salted hash.

   FUTURE-READY SHAPE: every function below is written the way its
   eventual Spring Boot equivalent would be called, so swapping the
   body for a real fetch() to a backend later is a small, contained
   change — no caller code (LoginScreen, AuthProvider) needs to change:

     hasCredentials()                 -> GET  /api/auth/exists
     authService.register(u, p)       -> POST /api/auth/register
     authService.login(u, p)          -> POST /api/auth/login        (returns a JWT instead of a local session)
     authService.logout()             -> POST /api/auth/logout       (or just discard the JWT client-side)
     authService.getSession()         -> read JWT from storage + verify/decode instead of reading local JSON
     authService.changePassword(...)  -> POST /api/auth/change-password

   All of these are already async, returning { ok, error } shaped
   results, so the calling components never need to know whether the
   implementation is local hashing or a network call.
----------------------------------------------------------------*/

const AUTH_KEY = "pft_auth_v1"; // { username, salt, hash }
const SESSION_KEY = "pft_session_v1"; // { username, loggedInAt }

/** Converts a Uint8Array / ArrayBuffer to a hex string. */
const bufToHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

const randomSalt = () => {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bufToHex(bytes);
};

/** Salted SHA-256 hash via the browser's native SubtleCrypto. Falls
 *  back to a (weaker, but still non-plaintext) string hash if
 *  SubtleCrypto is unavailable, e.g. on a non-HTTPS origin — this
 *  keeps first-run setup from hard-failing in that edge case while
 *  still never persisting the raw password. */
async function hashPassword(password, salt) {
  const input = `${salt}:${password}`;
  if (window.crypto?.subtle?.digest) {
    const data = new TextEncoder().encode(input);
    const digest = await window.crypto.subtle.digest("SHA-256", data);
    return bufToHex(digest);
  }
  // Fallback: simple non-cryptographic hash (DJB2). Only reached when
  // SubtleCrypto truly isn't available (very old browser, or non-secure context).
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return "djb2_" + (hash >>> 0).toString(16);
}

function readAuthRecord() {
  try {
    const raw = safeStorage.getItem(AUTH_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeAuthRecord(record) {
  try {
    safeStorage.setItem(AUTH_KEY, JSON.stringify(record));
  } catch (e) {
    console.error("Failed to save credentials", e);
  }
}

function readSession() {
  try {
    const raw = safeStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

/** Whether any credentials have ever been set up on this device —
 *  the signal LoginScreen uses to decide "show setup" vs "show login". */
const hasCredentials = () => !!readAuthRecord();

/** The auth service: a small async interface kept deliberately
 *  identical in shape to what a real backend client would expose.
 *  Swapping localStorage for fetch() calls later means editing only
 *  inside these four functions. */
const authService = {
  async register(username, password) {
    const trimmed = username.trim();
    if (!trimmed) return { ok: false, error: "Username is required." };
    if (!password || password.length < 4) return { ok: false, error: "Password must be at least 4 characters." };

    const salt = randomSalt();
    const hash = await hashPassword(password, salt);
    writeAuthRecord({ username: trimmed, salt, hash, createdAt: new Date().toISOString() });
    safeStorage.setItem(SESSION_KEY, JSON.stringify({ username: trimmed, loggedInAt: new Date().toISOString() }));
    return { ok: true, username: trimmed };
  },

  async login(username, password) {
    const record = readAuthRecord();
    if (!record) return { ok: false, error: "No account set up on this device yet." };

    const trimmed = username.trim();
    if (trimmed.toLowerCase() !== record.username.toLowerCase()) {
      return { ok: false, error: "Incorrect username or password." };
    }
    const hash = await hashPassword(password, record.salt);
    if (hash !== record.hash) {
      return { ok: false, error: "Incorrect username or password." };
    }
    safeStorage.setItem(SESSION_KEY, JSON.stringify({ username: record.username, loggedInAt: new Date().toISOString() }));
    return { ok: true, username: record.username };
  },

  logout() {
    safeStorage.removeItem(SESSION_KEY);
  },

  getSession() {
    return readSession();
  },

  /** Lets a logged-in user change their password without resetting
   *  the device's "first-run" state. Not wired into the UI yet (not
   *  in the current requirements) but kept here so it's a one-screen
   *  addition later rather than new architecture. */
  async changePassword(currentPassword, newPassword) {
    const record = readAuthRecord();
    if (!record) return { ok: false, error: "No account exists." };
    const currentHash = await hashPassword(currentPassword, record.salt);
    if (currentHash !== record.hash) return { ok: false, error: "Current password is incorrect." };
    if (!newPassword || newPassword.length < 4) return { ok: false, error: "New password must be at least 4 characters." };
    const salt = randomSalt();
    const hash = await hashPassword(newPassword, salt);
    writeAuthRecord({ ...record, salt, hash });
    return { ok: true };
  },
};

/** Derives month (1-12) and year from a YYYY-MM-DD date string.
 *  Stored alongside each transaction (not computed on the fly) so that
 *  monthly/yearly aggregation, budgets, and reports in later phases
 *  can group and filter with a simple equality check instead of
 *  re-parsing dates across the whole dataset every render. */
const deriveDateParts = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return { month: null, year: null };
  return { month: d.getMonth() + 1, year: d.getFullYear() };
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

/* ---------------------------------------------------------------
   PERIOD FILTER ENGINE
   ---------------------------------------------------------------
   Single source of truth for "what date range is selected right now."
   Every consumer — dashboard KPIs, insights, yearly view, and any
   future chart/report/budget module — reads through this engine
   instead of re-deriving date math locally. Resolving a period key
   to { start, end } plus its "equivalent previous period" up front
   means new features just call filterByRange(transactions, range)
   and never need to know how "Last 3 Months" was computed.
----------------------------------------------------------------*/

const PERIOD_OPTIONS = [
  { key: "current_month", label: "Current Month" },
  { key: "previous_month", label: "Previous Month" },
  { key: "last_3_months", label: "Last 3 Months" },
  { key: "last_6_months", label: "Last 6 Months" },
  { key: "current_year", label: "Current Year" },
  { key: "previous_year", label: "Previous Year" },
  { key: "specific_month", label: "Pick Month & Year" },
  { key: "custom", label: "Custom Range" },
];

const toISO = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const startOfMonth = (y, m) => new Date(y, m, 1);
const endOfMonth = (y, m) => new Date(y, m + 1, 0);

/** Resolves a period key (+ optional custom start/end) into a concrete
 *  date range, a human label, and the "equivalent previous period" for
 *  comparison — e.g. Current Month -> Previous Month, Current Year ->
 *  Previous Year, a custom 10-day range -> the preceding 10 days. */
function resolvePeriod(periodKey, custom = {}) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (periodKey) {
    case "current_month": {
      const start = startOfMonth(y, m);
      const end = endOfMonth(y, m);
      const prevStart = startOfMonth(y, m - 1);
      const prevEnd = endOfMonth(y, m - 1);
      return {
        start: toISO(start), end: toISO(end),
        label: `${MONTH_NAMES[m]} ${y}`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd),
        prevLabel: `${MONTH_NAMES[(m - 1 + 12) % 12]} ${m === 0 ? y - 1 : y}`,
      };
    }
    case "previous_month": {
      const start = startOfMonth(y, m - 1);
      const end = endOfMonth(y, m - 1);
      const prevStart = startOfMonth(y, m - 2);
      const prevEnd = endOfMonth(y, m - 2);
      const label = `${MONTH_NAMES[(m - 1 + 12) % 12]} ${m === 0 ? y - 1 : y}`;
      const prevMonthIdx = (m - 2 + 24) % 12;
      const prevYearForLabel = m <= 1 ? y - 1 : y;
      return {
        start: toISO(start), end: toISO(end), label,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd),
        prevLabel: `${MONTH_NAMES[prevMonthIdx]} ${prevYearForLabel}`,
      };
    }
    case "last_3_months": {
      const start = startOfMonth(y, m - 2);
      const end = endOfMonth(y, m);
      const prevStart = startOfMonth(y, m - 5);
      const prevEnd = endOfMonth(y, m - 3);
      return {
        start: toISO(start), end: toISO(end),
        label: `Last 3 Months (${MONTH_SHORT[(m - 2 + 12) % 12]}–${MONTH_SHORT[m]})`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd),
        prevLabel: "Preceding 3 Months",
      };
    }
    case "last_6_months": {
      const start = startOfMonth(y, m - 5);
      const end = endOfMonth(y, m);
      const prevStart = startOfMonth(y, m - 11);
      const prevEnd = endOfMonth(y, m - 6);
      return {
        start: toISO(start), end: toISO(end),
        label: `Last 6 Months (${MONTH_SHORT[(m - 5 + 12) % 12]}–${MONTH_SHORT[m]})`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd),
        prevLabel: "Preceding 6 Months",
      };
    }
    case "current_year": {
      const start = new Date(y, 0, 1);
      const end = new Date(y, 11, 31);
      const prevStart = new Date(y - 1, 0, 1);
      const prevEnd = new Date(y - 1, 11, 31);
      return {
        start: toISO(start), end: toISO(end), label: `${y}`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd), prevLabel: `${y - 1}`,
      };
    }
    case "previous_year": {
      const start = new Date(y - 1, 0, 1);
      const end = new Date(y - 1, 11, 31);
      const prevStart = new Date(y - 2, 0, 1);
      const prevEnd = new Date(y - 2, 11, 31);
      return {
        start: toISO(start), end: toISO(end), label: `${y - 1}`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd), prevLabel: `${y - 2}`,
      };
    }
    case "specific_month": {
      const pickYear = custom.year || y;
      const pickMonth = custom.month != null ? custom.month : m; // 0-indexed
      const start = startOfMonth(pickYear, pickMonth);
      const end = endOfMonth(pickYear, pickMonth);
      const prevStart = startOfMonth(pickYear, pickMonth - 1);
      const prevEnd = endOfMonth(pickYear, pickMonth - 1);
      const prevMonthIdx = (pickMonth - 1 + 24) % 12;
      const prevYearForLabel = pickMonth === 0 ? pickYear - 1 : pickYear;
      return {
        start: toISO(start), end: toISO(end),
        label: `${MONTH_NAMES[pickMonth]} ${pickYear}`,
        prevStart: toISO(prevStart), prevEnd: toISO(prevEnd),
        prevLabel: `${MONTH_NAMES[prevMonthIdx]} ${prevYearForLabel}`,
      };
    }
    case "custom": {
      const start = custom.start || todayISO();
      const end = custom.end || todayISO();
      // Equivalent previous period: an immediately preceding span of the same length.
      const startD = new Date(start + "T00:00:00");
      const endD = new Date(end + "T00:00:00");
      const spanDays = Math.max(1, Math.round((endD - startD) / 86400000) + 1);
      const prevEndD = new Date(startD);
      prevEndD.setDate(prevEndD.getDate() - 1);
      const prevStartD = new Date(prevEndD);
      prevStartD.setDate(prevStartD.getDate() - (spanDays - 1));
      return {
        start, end,
        label: `${fmtDate(start)} – ${fmtDate(end)}`,
        prevStart: toISO(prevStartD), prevEnd: toISO(prevEndD),
        prevLabel: `${fmtDate(toISO(prevStartD))} – ${fmtDate(toISO(prevEndD))}`,
      };
    }
    default:
      return resolvePeriod("current_month");
  }
}

/** The single filtering primitive every feature (KPIs, insights, yearly
 *  view, and future charts/budgets/reports) should call. Pure function,
 *  no hooks — safe to reuse outside React too (e.g. in export logic). */
function filterByRange(transactions, start, end) {
  return transactions.filter((t) => t.date >= start && t.date <= end);
}

/** Aggregates a transaction list into the metrics every period-aware
 *  surface needs: totals, savings rate, top category, biggest single
 *  expense, and counts. Centralizing this means Insights, KPI cards,
 *  and later budget/report features stay numerically consistent. */
function summarize(transactions) {
  let income = 0;
  let expense = 0;
  const expenseByCategory = {};
  let highestExpense = null;

  for (const t of transactions) {
    if (t.type === "income") {
      income += t.amount;
    } else {
      expense += t.amount;
      expenseByCategory[t.category] = (expenseByCategory[t.category] || 0) + t.amount;
      if (!highestExpense || t.amount > highestExpense.amount) highestExpense = t;
    }
  }

  const savings = income - expense;
  const savingsRate = income > 0 ? (savings / income) * 100 : 0;

  let topCategory = null;
  let topCategoryAmount = 0;
  for (const [cat, amt] of Object.entries(expenseByCategory)) {
    if (amt > topCategoryAmount) {
      topCategory = cat;
      topCategoryAmount = amt;
    }
  }

  return {
    income, expense, savings, savingsRate,
    topCategory, topCategoryAmount,
    highestExpense,
    transactionCount: transactions.length,
    expenseByCategory,
  };
}

/** Percentage change from `prev` to `current`. Returns null when prev
 *  is 0 (undefined % change) so the UI can render "—" instead of
 *  a misleading Infinity or NaN. */
function percentChange(current, prev) {
  if (prev === 0) return current === 0 ? 0 : null;
  return ((current - prev) / Math.abs(prev)) * 100;
}

/** Builds a month-by-month breakdown (Jan..Dec) for a given year —
 *  the data shape the Yearly View and, later, the yearly growth chart
 *  both consume directly. */
function buildYearlyBreakdown(transactions, year) {
  const months = MONTH_NAMES.map((name, idx) => ({
    month: idx + 1,
    name,
    short: MONTH_SHORT[idx],
    income: 0,
    expense: 0,
  }));

  for (const t of transactions) {
    if (t.year === year && t.month >= 1 && t.month <= 12) {
      const row = months[t.month - 1];
      if (t.type === "income") row.income += t.amount;
      else row.expense += t.amount;
    }
  }

  return months.map((row) => ({ ...row, savings: row.income - row.expense }));
}

/** Normalizes a transaction object: fills derived fields, defaults,
 *  and audit timestamps. Used on create, edit, and CSV import so every
 *  transaction in the store always has the full, future-proof shape. */
const normalizeTransaction = (t, { touch = false } = {}) => {
  const { month, year } = deriveDateParts(t.date);
  const now = new Date().toISOString();
  return {
    id: t.id || uid(),
    date: t.date,
    description: (t.description || "").trim(),
    category: t.category || "Other",
    type: t.type === "income" ? "income" : "expense",
    amount: Number.isFinite(t.amount) ? t.amount : parseFloat(t.amount) || 0,
    paymentMode: PAYMENT_MODES.includes(t.paymentMode) ? t.paymentMode : "Cash",
    notes: (t.notes || "").trim(),
    month,
    year,
    createdAt: t.createdAt || now,
    updatedAt: touch ? now : t.updatedAt || now,
  };
};

/* ---------------------------------------------------------------
   CSV IMPORT / EXPORT
----------------------------------------------------------------*/

const CSV_COLUMNS = [
  "date", "description", "category", "type", "amount",
  "paymentMode", "notes", "month", "year",
];

const csvEscape = (val) => {
  const s = String(val ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

function transactionsToCSV(transactions) {
  const header = CSV_COLUMNS.join(",");
  const rows = transactions.map((t) => CSV_COLUMNS.map((col) => csvEscape(t[col])).join(","));
  return [header, ...rows].join("\n");
}

function downloadCSV(transactions) {
  const csv = transactionsToCSV(transactions);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ledger-transactions-${todayISO()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Parses CSV text into raw row objects. Handles quoted fields with
 *  embedded commas/newlines. Returns an array of plain objects keyed
 *  by the header row — validation/normalization happens separately. */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const filtered = rows.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (filtered.length < 2) return [];

  const headers = filtered[0].map((h) => h.trim());
  return filtered.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = r[idx] !== undefined ? r[idx].trim() : ""));
    return obj;
  });
}

/** Validates + normalizes imported rows. Returns { valid, errors }
 *  where valid is an array of ready-to-store transactions and errors
 *  is a list of { row, reason } for anything skipped. */
function importRowsToTransactions(rows) {
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

    const paymentMode =
      row.paymentMode ||
      row["Payment Method"] ||
      row["payment method"] ||
      "Cash";

    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(normalizedDate || "");
    const amountNum = parseFloat(rawAmount);
    const typeOk = rawType === "income" || rawType === "expense";

    if (!dateOk) return errors.push({ row: rowNum, reason: "Invalid or missing date (expected YYYY-MM-DD)" });
    if (!row.description || !row.description.trim()) {
      row.description = row.category
        ? `${row.category} Expense`
        : "Unknown Expense";
    }
    if (!typeOk) return errors.push({ row: rowNum, reason: 'Type must be "income" or "expense"' });
    if (!Number.isFinite(amountNum) || amountNum <= 0)
      return errors.push({ row: rowNum, reason: "Amount must be a positive number" });

    const fallbackCategories = rawType === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
    const category = fallbackCategories.includes(row.category) ? row.category : "Other";

    valid.push(
      normalizeTransaction({
        date: normalizedDate,
        description: row.description,
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

/* ---------------------------------------------------------------
   SEED DATA (first run only)
----------------------------------------------------------------*/

const seedTransactions = () => {
  const today = new Date();
  const d = (offset) => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - offset);
    return dt.toISOString().slice(0, 10);
  };
  const raw = [
    { date: d(0), description: "Grocery run", category: "Food", type: "expense", amount: 1200, paymentMode: "UPI", notes: "Weekly vegetables and essentials" },
    { date: d(0), description: "Freelance milestone payment", category: "Freelancing", type: "income", amount: 9000, paymentMode: "Bank Transfer", notes: "" },
    { date: d(1), description: "Monthly salary", category: "Salary", type: "income", amount: 85000, paymentMode: "Bank Transfer", notes: "Credited on the 1st" },
    { date: d(2), description: "Logo design project", category: "Freelancing", type: "income", amount: 12000, paymentMode: "UPI", notes: "" },
    { date: d(3), description: "Grocery run", category: "Food", type: "expense", amount: 2400, paymentMode: "Debit Card", notes: "" },
    { date: d(4), description: "Metro card recharge", category: "Travel", type: "expense", amount: 600, paymentMode: "UPI", notes: "" },
    { date: d(6), description: "New headphones", category: "Shopping", type: "expense", amount: 3200, paymentMode: "Credit Card", notes: "Sony WH-CH520" },
    { date: d(8), description: "Dentist visit", category: "Medical", type: "expense", amount: 1500, paymentMode: "Cash", notes: "Routine checkup" },
    { date: d(10), description: "Online course", category: "Education", type: "expense", amount: 999, paymentMode: "Credit Card", notes: "" },
    { date: d(12), description: "Mom's birthday gift", category: "Family", type: "expense", amount: 2000, paymentMode: "UPI", notes: "" },
    { date: d(15), description: "Consulting gig", category: "Business", type: "income", amount: 18000, paymentMode: "Bank Transfer", notes: "" },
    { date: d(18), description: "Dinner out", category: "Food", type: "expense", amount: 1800, paymentMode: "Credit Card", notes: "Anniversary dinner" },
    { date: d(35), description: "Monthly salary", category: "Salary", type: "income", amount: 85000, paymentMode: "Bank Transfer", notes: "" },
    { date: d(40), description: "Rent share to landlord", category: "Other", type: "expense", amount: 15000, paymentMode: "Bank Transfer", notes: "" },
    { date: d(45), description: "Interest payout", category: "Other", type: "income", amount: 450, paymentMode: "Bank Transfer", notes: "Savings account interest" },
  ];
  return raw.map(normalizeTransaction);
};

/* ---------------------------------------------------------------
   LOCAL STORAGE HELPERS
----------------------------------------------------------------*/

function loadTransactions() {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration: older records (Phase 1) lack paymentMode/notes/month/year.
      // Re-normalizing on load upgrades them transparently without data loss.
      return parsed.map(normalizeTransaction);
    }
  } catch (e) {
    console.error("Failed to load transactions", e);
  }
  const seeded = seedTransactions();
  try {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
  } catch (e) { }
  return seeded;
}

function saveTransactions(txns) {
  try {
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(txns));
  } catch (e) {
    console.error("Failed to save transactions", e);
  }
}

function loadTheme() {
  try {
    return safeStorage.getItem(THEME_KEY) || "dark";
  } catch (e) {
    return "dark";
  }
}

/* ---------------------------------------------------------------
   AUTH UI: LOGIN / FIRST-RUN SETUP SCREEN
----------------------------------------------------------------*/

function LoginScreen({ mode, onAuthenticated, theme, onToggleTheme }) {
  const isSetup = mode === "setup";
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");

    if (isSetup) {
      if (password !== confirmPassword) {
        setError("Passwords don't match.");
        return;
      }
    }

    setSubmitting(true);
    const result = isSetup
      ? await authService.register(username, password)
      : await authService.login(username, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    onAuthenticated(result.username);
  };

  return (
    <div className={`pft-root theme-${theme} auth-shell`}>
      <style>{CSS}</style>

      <div className="auth-card-wrap">
        <button className="icon-btn theme-toggle auth-theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>

        <div className="auth-card">
          <div className="brand auth-brand">
            <div className="brand-mark">
              <Wallet size={20} strokeWidth={2.4} />
            </div>
            <div className="brand-text">
              <span className="brand-title">Ledger</span>
              <span className="brand-sub">Personal Finance Tracker</span>
            </div>
          </div>

          <h2 className="auth-heading">
            {isSetup ? "Set up your account" : "Welcome back"}
          </h2>
          <p className="auth-subheading">
            {isSetup
              ? "Create a username and password to protect your financial data on this device."
              : "Enter your credentials to view your dashboard."}
          </p>

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-field">
              <label htmlFor="auth-username">Username</label>
              <div className="input-with-icon">
                <User size={15} />
                <input
                  id="auth-username"
                  type="text"
                  autoComplete="username"
                  placeholder="e.g. Chirag"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoFocus
                  required
                />
              </div>
            </div>

            <div className="form-field">
              <label htmlFor="auth-password">Password</label>
              <div className="input-with-icon">
                <Lock size={15} />
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={isSetup ? "new-password" : "current-password"}
                  placeholder={isSetup ? "At least 4 characters" : "Your password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={isSetup ? 4 : undefined}
                />
                <button
                  type="button"
                  className="input-icon-btn"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {isSetup && (
              <div className="form-field">
                <label htmlFor="auth-confirm">Confirm password</label>
                <div className="input-with-icon">
                  <Lock size={15} />
                  <input
                    id="auth-confirm"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="auth-error">
                <AlertTriangle size={14} />
                {error}
              </div>
            )}

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? "Please wait..." : isSetup ? "Create account & continue" : "Log in"}
            </button>
          </form>

          <div className="auth-footnote">
            <ShieldCheck size={13} />
            Your credentials and data stay on this device — nothing is sent anywhere.
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, icon: Icon, tone, pulse }) {
  return (
    <div className="kpi-card">
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className={`kpi-icon tone-${tone}`}>
          <Icon size={16} strokeWidth={2.25} />
        </span>
      </div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
      {pulse && (
        <div className="kpi-pulse-track">
          <div className="kpi-pulse-fill" style={{ width: `${pulse}%` }} />
        </div>
      )}
    </div>
  );
}

/** Renders the "vs previous equivalent period" line under a KPI card —
 *  e.g. "+₹4,200 (+12.4%) vs May 2026". `invert` flips the good/bad
 *  color logic for expense cards, where a decrease is the positive
 *  outcome. Handles the undefined-% case (prev period was zero). */
function ComparisonSub({ diff, pct, prevLabel, invert = false }) {
  const isUp = diff > 0;
  const isFlat = diff === 0;
  const goodDirection = invert ? diff <= 0 : diff >= 0;
  const Arrow = isFlat ? Minus : isUp ? ArrowUpRight : ArrowDownRight;
  const sign = isFlat ? "" : isUp ? "+" : "−";

  return (
    <span className={`comparison-sub ${goodDirection ? "good" : "bad"}`}>
      <Arrow size={11} />
      {sign}{currency(Math.abs(diff))}
      {pct !== null && <span className="comparison-pct"> ({sign}{Math.abs(pct).toFixed(1)}%)</span>}
      <span className="comparison-vs"> vs {prevLabel}</span>
    </span>
  );
}

/** A single metric tile inside the Insights panel. */
function InsightStat({ icon: Icon, tone, label, value, detail }) {
  return (
    <div className="insight-stat">
      <span className={`insight-icon tone-${tone}`}>
        <Icon size={14} strokeWidth={2.25} />
      </span>
      <div className="insight-stat-text">
        <span className="insight-label">{label}</span>
        <span className="insight-value">{value}</span>
        {detail && <span className="insight-detail">{detail}</span>}
      </div>
    </div>
  );
}

function CategoryBadge({ category }) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.Other;
  return (
    <span className="cat-badge" style={{ background: style.bg, color: style.fg }}>
      {category}
    </span>
  );
}

function ConfirmDialog({ open, onConfirm, onCancel, txn }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <h3>Delete transaction?</h3>
        <p>
          This will permanently remove <strong>"{txn?.description}"</strong> ({currency(txn?.amount)}). This can't be
          undone.
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   TRANSACTION FORM (Add / Edit)
----------------------------------------------------------------*/

function TransactionForm({ open, onClose, onSave, editing }) {
  const isEdit = !!editing;
  const [type, setType] = useState("expense");
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState(EXPENSE_CATEGORIES[0]);
  const [amount, setAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState(PAYMENT_MODES[0]);
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState({});

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (editing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setType(editing.type);
      setDate(editing.date);
      setDescription(editing.description);
      setCategory(editing.category);
      setAmount(String(editing.amount));
      setPaymentMode(editing.paymentMode || PAYMENT_MODES[0]);
      setNotes(editing.notes || "");
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setType("expense");
      setDate(todayISO());
      setDescription("");
      setCategory(EXPENSE_CATEGORIES[0]);
      setAmount("");
      setPaymentMode(PAYMENT_MODES[0]);
      setNotes("");
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setErrors({});
  }, [editing, open]);

  const categories = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!categories.includes(category)) setCategory(categories[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  if (!open) return null;

  const validate = () => {
    const errs = {};
    if (!date) errs.date = "Date is required";
    if (!description.trim()) errs.description = "Description is required";
    const num = parseFloat(amount);
    if (!amount || isNaN(num) || num <= 0) errs.amount = "Enter an amount greater than 0";
    return errs;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    onSave(
      normalizeTransaction(
        {
          ...(editing || {}),
          id: editing ? editing.id : undefined,
          date,
          description: description.trim(),
          category,
          type,
          amount: parseFloat(amount),
          paymentMode,
          notes: notes.trim(),
        },
        { touch: true }
      )
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isEdit ? "Edit transaction" : "Add transaction"}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="txn-form">
          <div className="type-toggle">
            <button
              type="button"
              className={`type-btn ${type === "income" ? "active income" : ""}`}
              onClick={() => setType("income")}
            >
              <ArrowUpRight size={15} /> Income
            </button>
            <button
              type="button"
              className={`type-btn ${type === "expense" ? "active expense" : ""}`}
              onClick={() => setType("expense")}
            >
              <ArrowDownRight size={15} /> Expense
            </button>
          </div>

          <div className="form-row">
            <div className="form-field">
              <label htmlFor="f-date">Date</label>
              <input
                id="f-date"
                type="date"
                value={date}
                max={todayISO()}
                onChange={(e) => setDate(e.target.value)}
                className={errors.date ? "err" : ""}
              />
              {errors.date && <span className="field-err">{errors.date}</span>}
            </div>
            <div className="form-field">
              <label htmlFor="f-amount">Amount (₹)</label>
              <input
                id="f-amount"
                type="number"
                inputMode="decimal"
                placeholder="0.00"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={errors.amount ? "err" : ""}
              />
              {errors.amount && <span className="field-err">{errors.amount}</span>}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="f-desc">Description</label>
            <input
              id="f-desc"
              type="text"
              placeholder="e.g. Grocery shopping at D-Mart"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={errors.description ? "err" : ""}
              maxLength={120}
            />
            {errors.description && <span className="field-err">{errors.description}</span>}
          </div>

          <div className="form-field">
            <label htmlFor="f-cat">Category</label>
            <div className="select-wrap">
              <select id="f-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} className="select-chevron" />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="f-pay">Payment mode</label>
            <div className="select-wrap">
              <select id="f-pay" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} className="select-chevron" />
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="f-notes">Notes <span className="label-optional">(optional)</span></label>
            <textarea
              id="f-notes"
              placeholder="Any extra detail worth remembering..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={280}
              rows={2}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={`btn btn-primary ${type}`}>
              {isEdit ? "Save changes" : "Add transaction"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   MAIN APP
----------------------------------------------------------------*/

function Dashboard({ onLogout, currentUser, theme, onToggleTheme }) {
  const [transactions, setTransactions] = useState(loadTransactions);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTxn, setEditingTxn] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Multi-column sorting
  const [sortKey, setSortKey] = useState("date"); // "date" | "description" | "category" | "paymentMode" | "amount"
  const [sortDir, setSortDir] = useState("desc"); // "asc" | "desc"

  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Bulk action states
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [deleteAllConfirmOpen, setDeleteAllConfirmOpen] = useState(false);

  /* ---- Time Period Analysis: global filter state ---- */
  const now = new Date();
  const [periodKey, setPeriodKey] = useState("current_month");
  const [pickedMonth, setPickedMonth] = useState(now.getMonth()); // 0-indexed
  const [pickedYear, setPickedYear] = useState(now.getFullYear());
  const [customStart, setCustomStart] = useState(todayISO());
  const [customEnd, setCustomEnd] = useState(todayISO());
  const [insightsOpen, setInsightsOpen] = useState(true);

  // Auto-reset page when filter changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentPage(1);
  }, [search, typeFilter, categoryFilter, periodKey, pickedMonth, pickedYear, customStart, customEnd]);

  useEffect(() => {
    saveTransactions(transactions);
  }, [transactions]);

  const allCategories = useMemo(
    () => Array.from(new Set(transactions.map((t) => t.category))).sort(),
    [transactions]
  );

  /* ---- Time Period Analysis: resolved range + scoped data ----
     This is the one place period selection turns into concrete dates.
     Every period-aware surface below (KPI cards, comparison strip,
     insights panel, yearly view) reads from `range`, `periodTxns`, and
     `prevPeriodTxns` — and so will future charts/budgets/reports, since
     they all key off the same filterByRange/summarize primitives. */
  const range = useMemo(() => {
    if (periodKey === "specific_month") return resolvePeriod("specific_month", { month: pickedMonth, year: pickedYear });
    if (periodKey === "custom") return resolvePeriod("custom", { start: customStart, end: customEnd });
    return resolvePeriod(periodKey);
  }, [periodKey, pickedMonth, pickedYear, customStart, customEnd]);

  const periodTxns = useMemo(
    () => filterByRange(transactions, range.start, range.end),
    [transactions, range.start, range.end]
  );

  const prevPeriodTxns = useMemo(
    () => filterByRange(transactions, range.prevStart, range.prevEnd),
    [transactions, range.prevStart, range.prevEnd]
  );

  const periodSummary = useMemo(() => summarize(periodTxns), [periodTxns]);
  const prevPeriodSummary = useMemo(() => summarize(prevPeriodTxns), [prevPeriodTxns]);

  const comparison = useMemo(() => {
    const income = percentChange(periodSummary.income, prevPeriodSummary.income);
    const expense = percentChange(periodSummary.expense, prevPeriodSummary.expense);
    const savings = percentChange(periodSummary.savings, prevPeriodSummary.savings);
    return {
      incomeDiff: periodSummary.income - prevPeriodSummary.income,
      incomePct: income,
      expenseDiff: periodSummary.expense - prevPeriodSummary.expense,
      expensePct: expense,
      savingsDiff: periodSummary.savings - prevPeriodSummary.savings,
      savingsPct: savings,
    };
  }, [periodSummary, prevPeriodSummary]);

  /* ---- Yearly View: month-by-month breakdown for the relevant year ---- */
  const yearlyViewYear = useMemo(() => {
    if (periodKey === "current_year") return now.getFullYear();
    if (periodKey === "previous_year") return now.getFullYear() - 1;
    if (periodKey === "specific_month") return pickedYear;
    // Fall back to the year the selected range starts in, for month-based presets
    return new Date(range.start + "T00:00:00").getFullYear();
  }, [periodKey, pickedYear, range.start]);

  const yearlyBreakdown = useMemo(
    () => buildYearlyBreakdown(transactions, yearlyViewYear),
    [transactions, yearlyViewYear]
  );

  const availableYears = useMemo(() => {
    const years = new Set(transactions.map((t) => t.year).filter(Boolean));
    years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [transactions]);

  /* ---- all-time + quick-glance totals (Today / This Month anchors) ----
     These stay fixed regardless of the period filter — "Current Balance"
     is inherently a running, all-time figure, and Today/This-Month are
     meant as constant quick-glance anchors alongside the period view. */
  const allTimeTotals = useMemo(() => {
    let income = 0;
    let expense = 0;
    const today = todayISO();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();

    let todayIncome = 0;
    let todayExpense = 0;
    let monthIncome = 0;
    let monthExpense = 0;

    for (const t of transactions) {
      if (t.type === "income") income += t.amount;
      else expense += t.amount;

      if (t.date === today) {
        if (t.type === "income") todayIncome += t.amount;
        else todayExpense += t.amount;
      }
      if (t.year === curYear && t.month === curMonth) {
        if (t.type === "income") monthIncome += t.amount;
        else monthExpense += t.amount;
      }
    }

    const savings = income - expense;
    const balance = savings; // single-account model: balance == net savings to date
    return {
      income, expense, savings, balance,
      todayIncome, todayExpense, monthIncome, monthExpense,
      monthLabel: `${MONTH_NAMES[curMonth - 1]} ${curYear}`,
    };
  }, [transactions]);

  /* ---- period-scoped totals: drive the 4 primary KPI cards ----
     periodSummary already has income/expense/savings/savingsRate from
     the summarize() call above; balance for a period is just its net
     savings, and the pulse bar reuses the same income-vs-expense ratio
     logic as before, scoped to the selected period instead of all time. */
  const periodTotals = useMemo(() => {
    const { income, expense, savings } = periodSummary;
    const pulse = income + expense > 0 ? Math.round((income / (income + expense)) * 100) : 50;
    return { income, expense, savings, balance: savings, pulse };
  }, [periodSummary]);

  /* ---- filtered + sorted list ---- */
  const visibleTransactions = useMemo(() => {
    let list = transactions;

    if (typeFilter !== "all") list = list.filter((t) => t.type === typeFilter);
    if (categoryFilter !== "all") list = list.filter((t) => t.category === categoryFilter);

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q) ||
          (t.paymentMode || "").toLowerCase().includes(q) ||
          (t.notes || "").toLowerCase().includes(q) ||
          currency(t.amount).toLowerCase().includes(q)
      );
    }

    list = [...list].sort((a, b) => {
      let valA, valB;
      if (sortKey === "date") {
        valA = new Date(a.date).getTime();
        valB = new Date(b.date).getTime();
      } else if (sortKey === "amount") {
        valA = a.amount;
        valB = b.amount;
      } else {
        valA = String(a[sortKey] || "").toLowerCase();
        valB = String(b[sortKey] || "").toLowerCase();
      }

      if (valA < valB) return sortDir === "asc" ? -1 : 1;
      if (valA > valB) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [transactions, typeFilter, categoryFilter, search, sortKey, sortDir]);

  // Paginated Sliced list
  const paginatedTransactions = useMemo(() => {
    const startIdx = (currentPage - 1) * pageSize;
    return visibleTransactions.slice(startIdx, startIdx + pageSize);
  }, [visibleTransactions, currentPage, pageSize]);

  /* ---- handlers ---- */
  const openAddForm = useCallback(() => {
    setEditingTxn(null);
    setFormOpen(true);
  }, []);

  const openEditForm = useCallback((txn) => {
    setEditingTxn(txn);
    setFormOpen(true);
  }, []);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditingTxn(null);
  }, []);

  const handleSave = useCallback(
    (txn) => {
      setTransactions((prev) => {
        const exists = prev.some((t) => t.id === txn.id);
        if (exists) return prev.map((t) => (t.id === txn.id ? txn : t));
        return [txn, ...prev];
      });
      closeForm();
    },
    [closeForm]
  );

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const targetId = deleteTarget.id;
    setTransactions((prev) => prev.filter((t) => t.id !== targetId));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(targetId);
      return next;
    });
    setDeleteTarget(null);
  }, [deleteTarget]);

  // Bulk action handlers
  const handleToggleSelectRow = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    const allVisibleIds = visibleTransactions.map((t) => t.id);
    const areAllSelected = allVisibleIds.every((id) => selectedIds.has(id));

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (areAllSelected) {
        // Deselect all visible
        allVisibleIds.forEach((id) => next.delete(id));
      } else {
        // Select all visible
        allVisibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, [visibleTransactions, selectedIds]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleConfirmBulkDelete = useCallback(() => {
    setTransactions((prev) => prev.filter((t) => !selectedIds.has(t.id)));
    setSelectedIds(new Set());
    setBulkConfirmOpen(false);
  }, [selectedIds]);

  const handleConfirmDeleteAll = useCallback(() => {
    setTransactions([]);
    setSelectedIds(new Set());
    setDeleteAllConfirmOpen(false);
  }, []);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  /* ---- CSV import / export ---- */
  const fileInputRef = useRef(null);
  const [importResult, setImportResult] = useState(null); // { added, skipped, errors }

  const handleExportCSV = useCallback(() => {
    downloadCSV(transactions);
  }, [transactions]);

  const triggerImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);


  function getMonthKey(dateStr) {
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  const handleImportFile = useCallback((e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    const allValid = [];
    const allErrors = [];

    Promise.all(
      files.map(
        (file) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              try {
                const rows = parseCSV(String(reader.result));
                const { valid, errors } = importRowsToTransactions(rows);
                allValid.push(...valid);
                allErrors.push(
                  ...errors.map((err) => ({
                    ...err,
                    file: file.name,
                  }))
                );
              } catch {
                allErrors.push({
                  file: file.name,
                  row: "-",
                  reason: "Could not read this file as CSV.",
                });
              }
              resolve();
            };
            reader.readAsText(file);
          })
      )
    ).then(() => {
      if (allValid.length) {
        setTransactions((prev) => {
          const importedMonths = new Set(
            allValid
              .map((tx) => getMonthKey(tx.date))
              .filter(Boolean)
          );

          const remainingTransactions = prev.filter(
            (tx) => !importedMonths.has(getMonthKey(tx.date))
          );

          return [...allValid, ...remainingTransactions];
        });
      }

      setImportResult({
        added: allValid.length,
        errors: allErrors,
      });
    });

    e.target.value = ""; // allow re-selecting the same files
  }, []);

  const hasFilters = search || typeFilter !== "all" || categoryFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setTypeFilter("all");
    setCategoryFilter("all");
  };

  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  return (
    <div className={`pft-root theme-${theme}`}>
      <style>{CSS}</style>

      <div className="app-shell">
        {/* Header */}
        <header className="app-header">
          <div className="brand">
            <div className="brand-mark">
              <Wallet size={18} strokeWidth={2.4} />
            </div>
            <div className="brand-text">
              <span className="brand-title">Ledger</span>
              <span className="brand-sub">
                {currentUser ? `Signed in as ${currentUser}` : "Personal Finance Tracker"}
              </span>
            </div>
          </div>

          <div className="header-actions">
            <button className="icon-btn theme-toggle" onClick={onToggleTheme} aria-label="Toggle theme">
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleImportFile}
              multiple
              style={{ display: "none" }}
            />
            <button className="btn btn-ghost csv-btn" onClick={triggerImport}>
              <Upload size={15} />
              <span>Import CSV</span>
            </button>
            <button className="btn btn-ghost csv-btn" onClick={handleExportCSV}>
              <Download size={15} />
              <span>Export CSV</span>
            </button>
            {transactions.length > 0 && (
              <button className="btn btn-ghost danger-btn" onClick={() => setDeleteAllConfirmOpen(true)} title="Delete all transactions from system">
                <Trash2 size={15} />
                <span>Delete All</span>
              </button>
            )}
            <button className="btn btn-primary add-btn" onClick={openAddForm}>
              <Plus size={16} strokeWidth={2.5} />
              <span>Add transaction</span>
            </button>
            <button
              className="icon-btn logout-btn"
              onClick={() => setLogoutConfirmOpen(true)}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>

        {importResult && (
          <div className={`import-banner ${importResult.errors.length ? "warn" : "ok"}`}>
            <div className="import-banner-text">
              <strong>{importResult.added}</strong> transaction{importResult.added === 1 ? "" : "s"} imported
              {importResult.errors.length > 0 && (
                <> — <strong>{importResult.errors.length}</strong> row{importResult.errors.length === 1 ? "" : "s"} skipped</>
              )}
              {importResult.errors.length > 0 && (
                <ul className="import-error-list">
                  {importResult.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>Row {e.row}: {e.reason}</li>
                  ))}
                  {importResult.errors.length > 5 && <li>+ {importResult.errors.length - 5} more</li>}
                </ul>
              )}
            </div>
            <button className="icon-btn" onClick={() => setImportResult(null)} aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        )}

        {/* Time Period Analysis: global filter */}
        <section className="period-bar" aria-label="Time period filter">
          <div className="period-presets">
            {PERIOD_OPTIONS.filter((p) => p.key !== "specific_month" && p.key !== "custom").map((p) => (
              <button
                key={p.key}
                className={`period-chip ${periodKey === p.key ? "active" : ""}`}
                onClick={() => setPeriodKey(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="period-picker">
            <div className="select-wrap small">
              <select
                value={pickedMonth}
                onChange={(e) => {
                  setPickedMonth(Number(e.target.value));
                  setPeriodKey("specific_month");
                }}
              >
                {MONTH_NAMES.map((m, idx) => (
                  <option key={m} value={idx}>{m}</option>
                ))}
              </select>
              <ChevronDown size={13} className="select-chevron" />
            </div>
            <div className="select-wrap small">
              <select
                value={pickedYear}
                onChange={(e) => {
                  setPickedYear(Number(e.target.value));
                  setPeriodKey("specific_month");
                }}
              >
                {availableYears.map((yr) => (
                  <option key={yr} value={yr}>{yr}</option>
                ))}
              </select>
              <ChevronDown size={13} className="select-chevron" />
            </div>

            <button
              className={`period-chip custom-chip ${periodKey === "custom" ? "active" : ""}`}
              onClick={() => setPeriodKey("custom")}
            >
              <SlidersHorizontal size={13} /> Custom
            </button>
          </div>

          {periodKey === "custom" && (
            <div className="custom-range-row">
              <div className="form-field">
                <label htmlFor="cr-start">From</label>
                <input id="cr-start" type="date" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} />
              </div>
              <div className="form-field">
                <label htmlFor="cr-end">To</label>
                <input id="cr-end" type="date" value={customEnd} min={customStart} max={todayISO()} onChange={(e) => setCustomEnd(e.target.value)} />
              </div>
            </div>
          )}
        </section>

        {/* Dashboard Hero KPI + Primary Period KPIs */}
        <section className="kpi-grid-primary" aria-label="Primary Financial summary">
          <div className="kpi-hero-wrapper">
            <KpiCard
              label="Current Balance"
              value={currency(allTimeTotals.balance)}
              sub="Income minus expenses, all time"
              icon={allTimeTotals.balance >= 0 ? TrendingUp : TrendingDown}
              tone={allTimeTotals.balance >= 0 ? "balance" : "expense"}
              pulse={periodTotals.pulse}
            />
          </div>
          <div className="kpi-details-grid">
            <KpiCard
              label={`Income · ${range.label}`}
              value={currency(periodTotals.income)}
              sub={<ComparisonSub diff={comparison.incomeDiff} pct={comparison.incomePct} prevLabel={range.prevLabel} />}
              icon={ArrowUpRight}
              tone="income"
            />
            <KpiCard
              label={`Expense · ${range.label}`}
              value={currency(periodTotals.expense)}
              sub={<ComparisonSub diff={comparison.expenseDiff} pct={comparison.expensePct} prevLabel={range.prevLabel} invert />}
              icon={ArrowDownRight}
              tone="expense"
            />
            <KpiCard
              label={`Savings · ${range.label}`}
              value={currency(periodTotals.savings)}
              sub={<ComparisonSub diff={comparison.savingsDiff} pct={comparison.savingsPct} prevLabel={range.prevLabel} />}
              icon={PiggyBank}
              tone={periodTotals.savings >= 0 ? "income" : "expense"}
            />
          </div>
        </section>

        {/* Secondary KPI Anchors */}
        <section className="kpi-grid-secondary" aria-label="Secondary Financial summary">
          <KpiCard
            label="Today's Income"
            value={currency(allTimeTotals.todayIncome)}
            sub={fmtDate(todayISO())}
            icon={CalendarClock}
            tone="income"
          />
          <KpiCard
            label="Today's Expense"
            value={currency(allTimeTotals.todayExpense)}
            sub={fmtDate(todayISO())}
            icon={CalendarClock}
            tone="expense"
          />
          <KpiCard
            label="This Month's Income"
            value={currency(allTimeTotals.monthIncome)}
            sub={allTimeTotals.monthLabel}
            icon={CalendarDays}
            tone="income"
          />
          <KpiCard
            label="This Month's Expense"
            value={currency(allTimeTotals.monthExpense)}
            sub={allTimeTotals.monthLabel}
            icon={CalendarDays}
            tone="expense"
          />
        </section>

        {/* Time Period Analysis: Insights + Yearly View */}
        <section className="insights-card">
          <button className="insights-toggle" onClick={() => setInsightsOpen((o) => !o)}>
            <span className="insights-toggle-label">
              <BarChart3 size={15} />
              Time Period Analysis — {range.label}
            </span>
            <ChevronDown size={16} className={`chevron-rotate ${insightsOpen ? "open" : ""}`} />
          </button>

          {insightsOpen && (
            <div className="insights-body">
              <div className="insights-grid">
                <InsightStat icon={ArrowUpRight} tone="income" label="Income" value={currency(periodSummary.income)} />
                <InsightStat icon={ArrowDownRight} tone="expense" label="Expense" value={currency(periodSummary.expense)} />
                <InsightStat icon={PiggyBank} tone={periodSummary.savings >= 0 ? "income" : "expense"} label="Savings" value={currency(periodSummary.savings)} />
                <InsightStat
                  icon={TrendingUp}
                  tone={periodSummary.savingsRate >= 0 ? "balance" : "expense"}
                  label="Savings Rate"
                  value={`${periodSummary.savingsRate.toFixed(1)}%`}
                />
                <InsightStat
                  icon={Tag}
                  tone="expense"
                  label="Top Spending Category"
                  value={periodSummary.topCategory || "—"}
                  detail={periodSummary.topCategory ? currency(periodSummary.topCategoryAmount) : null}
                />
                <InsightStat
                  icon={Receipt}
                  tone="expense"
                  label="Highest Expense"
                  value={periodSummary.highestExpense ? currency(periodSummary.highestExpense.amount) : "—"}
                  detail={periodSummary.highestExpense ? periodSummary.highestExpense.description : null}
                />
                <InsightStat icon={ListChecks} tone="balance" label="Transactions" value={periodSummary.transactionCount} />
              </div>

              {/* Yearly View: month-by-month breakdown */}
              <div className="yearly-view">
                <div className="yearly-view-header">
                  <h4>Month-wise breakdown — {yearlyViewYear}</h4>
                </div>
                <div className="yearly-table-scroll">
                  <table className="yearly-table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="th-amount">Income</th>
                        <th className="th-amount">Expense</th>
                        <th className="th-amount">Savings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyBreakdown.map((row) => (
                        <tr key={row.month} className={row.income + row.expense === 0 ? "empty-month" : ""}>
                          <td>{row.short}</td>
                          <td className="cell-amount income">{row.income ? currency(row.income) : "—"}</td>
                          <td className="cell-amount expense">{row.expense ? currency(row.expense) : "—"}</td>
                          <td className={`cell-amount ${row.savings >= 0 ? "income" : "expense"}`}>
                            {row.income + row.expense > 0 ? currency(row.savings) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Total</td>
                        <td className="cell-amount income">
                          {currency(yearlyBreakdown.reduce((s, r) => s + r.income, 0))}
                        </td>
                        <td className="cell-amount expense">
                          {currency(yearlyBreakdown.reduce((s, r) => s + r.expense, 0))}
                        </td>
                        <td className="cell-amount income">
                          {currency(yearlyBreakdown.reduce((s, r) => s + r.savings, 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Toolbar */}
        <section className="toolbar">
          <div className="search-box">
            <Search size={15} />
            <input
              type="text"
              placeholder="Search description, category, payment mode, notes..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search transactions"
            />
          </div>

          <div className="filter-group">
            <div className="select-wrap small">
              <Filter size={13} className="filter-icon" />
              <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">All types</option>
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
              <ChevronDown size={13} className="select-chevron" />
            </div>

            <div className="select-wrap small">
              <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
                <option value="all">All categories</option>
                {allCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} className="select-chevron" />
            </div>

            {hasFilters && (
              <button className="btn btn-ghost clear-btn" onClick={clearFilters}>
                Clear
              </button>
            )}
          </div>
        </section>

        {/* Table */}
        <section className="table-card">
          {visibleTransactions.length === 0 ? (
            <div className="empty-state">
              <ReceiptText size={28} strokeWidth={1.6} />
              <h4>{transactions.length === 0 ? "No transactions yet" : "Nothing matches those filters"}</h4>
              <p>
                {transactions.length === 0
                  ? "Add your first income or expense to start tracking your cash flow."
                  : "Try adjusting your search or filters."}
              </p>
              {transactions.length === 0 ? (
                <button className="btn btn-primary" onClick={openAddForm}>
                  <Plus size={15} /> Add transaction
                </button>
              ) : (
                <button className="btn btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              {selectedIds.size > 0 && (
                <div className="bulk-action-bar">
                  <div className="bulk-info">
                    <strong>{selectedIds.size}</strong> transaction{selectedIds.size === 1 ? "" : "s"} selected
                  </div>
                  <div className="bulk-buttons">
                    <button className="btn btn-ghost" onClick={handleClearSelection}>
                      Clear selection
                    </button>
                    <button className="btn btn-danger" onClick={() => setBulkConfirmOpen(true)}>
                      <Trash2 size={14} /> Delete Selected
                    </button>
                  </div>
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="th-checkbox">
                        <input
                          type="checkbox"
                          checked={visibleTransactions.length > 0 && visibleTransactions.every((t) => selectedIds.has(t.id))}
                          onChange={handleToggleSelectAll}
                          aria-label="Select all transactions"
                        />
                      </th>
                      <th onClick={() => handleSort("date")} className="sortable-th">
                        <div className="th-content">
                          Date {sortKey === "date" && (sortDir === "asc" ? "↑" : "↓")}
                        </div>
                      </th>
                      <th onClick={() => handleSort("description")} className="sortable-th">
                        <div className="th-content">
                          Description {sortKey === "description" && (sortDir === "asc" ? "↑" : "↓")}
                        </div>
                      </th>
                      <th onClick={() => handleSort("category")} className="sortable-th">
                        <div className="th-content">
                          Category {sortKey === "category" && (sortDir === "asc" ? "↑" : "↓")}
                        </div>
                      </th>
                      <th>Type</th>
                      <th onClick={() => handleSort("paymentMode")} className="sortable-th">
                        <div className="th-content">
                          Payment {sortKey === "paymentMode" && (sortDir === "asc" ? "↑" : "↓")}
                        </div>
                      </th>
                      <th onClick={() => handleSort("amount")} className="sortable-th th-amount">
                        <div className="th-content th-amount">
                          Amount {sortKey === "amount" && (sortDir === "asc" ? "↑" : "↓")}
                        </div>
                      </th>
                      <th className="th-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedTransactions.map((t) => {
                      const isSelected = selectedIds.has(t.id);
                      return (
                        <tr key={t.id} className={isSelected ? "row-selected" : ""}>
                          <td className="cell-checkbox">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleSelectRow(t.id)}
                              aria-label={`Select transaction ${t.description}`}
                            />
                          </td>
                          <td className="cell-date">{fmtDate(t.date)}</td>
                          <td className="cell-desc" title={t.notes || undefined}>
                            {t.description}
                            {t.notes && <span className="notes-dot" title={t.notes} aria-label="Has notes" />}
                          </td>
                          <td>
                            <CategoryBadge category={t.category} />
                          </td>
                          <td>
                            <span className={`type-chip ${t.type}`}>
                              {t.type === "income" ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                              {t.type === "income" ? "Income" : "Expense"}
                            </span>
                          </td>
                          <td className="cell-pay">{t.paymentMode}</td>
                          <td className={`cell-amount ${t.type}`}>
                            {t.type === "income" ? "+" : "−"}
                            {currency(t.amount)}
                          </td>
                          <td className="cell-actions">
                            <button className="icon-btn" onClick={() => openEditForm(t)} aria-label="Edit">
                              <Pencil size={14} />
                            </button>
                            <button
                              className="icon-btn danger"
                              onClick={() => setDeleteTarget(t)}
                              aria-label="Delete"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination controls */}
              <div className="pagination-footer">
                <div className="pagination-info">
                  Showing <strong>{Math.min(visibleTransactions.length, (currentPage - 1) * pageSize + 1)}-{Math.min(visibleTransactions.length, currentPage * pageSize)}</strong> of <strong>{visibleTransactions.length}</strong> transaction{visibleTransactions.length === 1 ? "" : "s"}
                </div>
                <div className="pagination-actions">
                  <div className="select-wrap small page-size-select">
                    <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setCurrentPage(1); }}>
                      <option value={10}>10 per page</option>
                      <option value={25}>25 per page</option>
                      <option value={50}>50 per page</option>
                      <option value={100}>100 per page</option>
                    </select>
                    <ChevronDown size={13} className="select-chevron" />
                  </div>
                  <div className="page-nav">
                    <button
                      className="icon-btn page-nav-btn"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="page-nav-indicator">
                      Page <strong>{currentPage}</strong> of {Math.ceil(visibleTransactions.length / pageSize) || 1}
                    </span>
                    <button
                      className="icon-btn page-nav-btn"
                      disabled={currentPage >= Math.ceil(visibleTransactions.length / pageSize)}
                      onClick={() => setCurrentPage((p) => Math.min(Math.ceil(visibleTransactions.length / pageSize), p + 1))}
                      aria-label="Next page"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <footer className="app-footer">
          Data is stored locally in this browser. {transactions.length} total transactions.
        </footer>
      </div>

      <TransactionForm open={formOpen} onClose={closeForm} onSave={handleSave} editing={editingTxn} />
      <ConfirmDialog
        open={!!deleteTarget}
        txn={deleteTarget}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      {bulkConfirmOpen && (
        <div className="modal-overlay" onClick={() => setBulkConfirmOpen(false)}>
          <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Selected Transactions?</h3>
            <p>
              This will permanently delete <strong>{selectedIds.size}</strong> selected transaction{selectedIds.size === 1 ? "" : "s"}. This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setBulkConfirmOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleConfirmBulkDelete}>
                Delete Selected
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteAllConfirmOpen && (
        <div className="modal-overlay" onClick={() => setDeleteAllConfirmOpen(false)}>
          <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>Delete All Transactions?</h3>
            <p>
              This will permanently delete <strong>all {transactions.length}</strong> transaction{transactions.length === 1 ? "" : "s"} from your ledger database. This action is irreversible.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setDeleteAllConfirmOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={handleConfirmDeleteAll}>
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}
      {logoutConfirmOpen && (
        <div className="modal-overlay" onClick={() => setLogoutConfirmOpen(false)}>
          <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>Log out?</h3>
            <p>You'll need your username and password to view your data again on this device.</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setLogoutConfirmOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={onLogout}>
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   AUTH GATE — top-level export
   ---------------------------------------------------------------
   Decides which of three screens to show: first-run setup, login,
   or the authenticated Dashboard. Session is checked once on mount
   (restoring across page refreshes) and re-checked after any
   login/logout action. Theme is read independently of auth state so
   it persists across the login screen and the dashboard alike. */
export default function FinanceTracker() {
  const [theme, setTheme] = useState(loadTheme);
  const [session, setSession] = useState(() => authService.getSession());

  useEffect(() => {
    try {
      safeStorage.setItem(THEME_KEY, theme);
    } catch {
      console.warn("Could not save theme to storage");
    }
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const handleAuthenticated = useCallback((username) => {
    setSession({ username, loggedInAt: new Date().toISOString() });
  }, []);

  const handleLogout = useCallback(() => {
    authService.logout();
    setSession(null);
  }, []);

  if (!session) {
    const mode = hasCredentials() ? "login" : "setup";
    return <LoginScreen mode={mode} onAuthenticated={handleAuthenticated} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return <Dashboard onLogout={handleLogout} currentUser={session.username} theme={theme} onToggleTheme={toggleTheme} />;
}

/* ---------------------------------------------------------------
   STYLES
----------------------------------------------------------------*/

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Inter:wght@400;500;600;700&display=swap');

.pft-root {
  --radius: 12px;
  --radius-sm: 8px;
  --radius-md: 10px;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  min-height: 100vh;
  transition: background 0.2s ease, color 0.2s ease;
  -webkit-font-smoothing: antialiased;
}

.pft-root.theme-dark {
  --bg: #0F172A;
  --card: #1E293B;
  --card-border: #334155;
  --card-hover: #334155;
  --text: #F8FAFC;
  --text-muted: #94A3B8;
  --text-faint: #475569;
  --input-bg: #0F172A;
  --table-row-hover: #334155;
  --divider: #334155;
  --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 2px 4px -1px rgba(0, 0, 0, 0.1);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.15);
  
  --primary: #2563EB;
  --primary-hover: #3B82F6;
  --income-color: #10B981;
  --income-bg: rgba(16, 185, 129, 0.1);
  --expense-color: #EF4444;
  --expense-bg: rgba(239, 68, 68, 0.1);
  --balance-color: #2563EB;
  --balance-bg: rgba(37, 99, 235, 0.1);
  
  background: var(--bg);
  color: var(--text);
}

.pft-root.theme-light {
  --bg: #F8FAFC;
  --card: #FFFFFF;
  --card-border: #E2E8F0;
  --card-hover: #F8FAFC;
  --text: #0F172A;
  --text-muted: #64748B;
  --text-faint: #94A3B8;
  --input-bg: #F8FAFC;
  --table-row-hover: #F8FAFC;
  --divider: #E2E8F0;
  --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.05), 0 1px 2px 0 rgba(0, 0, 0, 0.02);
  --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.02);
  
  --primary: #2563EB;
  --primary-hover: #1D4ED8;
  --income-color: #10B981;
  --income-bg: rgba(16, 185, 129, 0.08);
  --expense-color: #EF4444;
  --expense-bg: rgba(239, 68, 68, 0.08);
  --balance-color: #2563EB;
  --balance-bg: rgba(37, 99, 235, 0.08);

  background: var(--bg);
  color: var(--text);
}

.pft-root * { box-sizing: border-box; }

.app-shell {
  max-width: 1180px;
  margin: 0 auto;
  padding: 24px 20px 60px;
}

/* ---------- Header ---------- */
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
  flex-wrap: wrap;
  gap: 14px;
}

.brand { display: flex; align-items: center; gap: 12px; }

.brand-mark {
  width: 38px; height: 38px;
  border-radius: 11px;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #4ADE80, #22C55E);
  color: #06280F;
  flex-shrink: 0;
}

.brand-text { display: flex; flex-direction: column; line-height: 1.2; }
.brand-title { font-family: 'Outfit', sans-serif; font-weight: 700; font-size: 17px; letter-spacing: -0.01em; }
.brand-sub { font-size: 11.5px; color: var(--text-muted); font-weight: 500; }

.header-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.csv-btn { font-size: 13px; }

.import-banner {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  margin-bottom: 18px;
  font-size: 13px;
}
.import-banner.ok { border-color: rgba(74,222,128,0.4); }
.import-banner.warn { border-color: rgba(250,204,21,0.4); }
.import-banner-text { color: var(--text); line-height: 1.5; }
.import-error-list {
  margin: 6px 0 0;
  padding-left: 18px;
  color: var(--text-muted);
  font-size: 12px;
}
.import-error-list li { margin-bottom: 2px; }

/* ---------- Buttons ---------- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 7px;
  font-family: 'Inter', sans-serif;
  font-size: 13.5px; font-weight: 600;
  padding: 10px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.btn:active { transform: scale(0.98); }

.btn-primary {
  background: var(--primary);
  color: #FFFFFF;
  box-shadow: 0 2px 4px rgba(37, 99, 235, 0.1);
}
.btn-primary:hover {
  background: var(--primary-hover);
}
.btn-primary.expense {
  background: var(--primary);
}

.btn-ghost {
  background: var(--card);
  color: var(--text-muted);
  border: 1px solid var(--card-border);
}
.btn-ghost:hover { color: var(--text); border-color: var(--text-faint); background: var(--table-row-hover); }

.btn-danger {
  background: var(--expense-color);
  color: #FFFFFF;
}
.btn-danger:hover {
  background: #DC2626;
}

.icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px;
  border-radius: var(--radius-sm);
  background: var(--card);
  border: 1px solid var(--card-border);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.icon-btn:hover { color: var(--text); border-color: var(--text-faint); }
.icon-btn.danger:hover { color: var(--expense-color); border-color: var(--expense-color); }

/* ---------- KPI Grid Layouts ---------- */
.kpi-grid-primary {
  display: grid;
  grid-template-columns: 1.2fr 2.8fr;
  gap: 16px;
  margin-bottom: 16px;
}
.kpi-details-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.kpi-grid-secondary {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

@media (max-width: 1024px) {
  .kpi-grid-primary {
    grid-template-columns: 1fr;
  }
  .kpi-details-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
@media (max-width: 768px) {
  .kpi-details-grid {
    grid-template-columns: 1fr;
  }
  .kpi-grid-secondary {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 480px) {
  .kpi-grid-secondary {
    grid-template-columns: 1fr;
  }
}

.kpi-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow);
  transition: border-color 0.15s ease, transform 0.15s ease;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.kpi-card:hover { border-color: var(--card-border-glow); }

.kpi-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.kpi-label { font-size: 13px; color: var(--text-muted); font-weight: 500; letter-spacing: 0.01em; }

.kpi-icon {
  width: 28px; height: 28px;
  border-radius: 6px;
  display: flex; align-items: center; justify-content: center;
}
.kpi-icon.tone-income { background: var(--income-bg); color: var(--income-color); }
.kpi-icon.tone-expense { background: var(--expense-bg); color: var(--expense-color); }
.kpi-icon.tone-balance { background: var(--balance-bg); color: var(--balance-color); }

.kpi-value {
  font-family: 'Outfit', sans-serif;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  margin-bottom: 6px;
  color: var(--text);
}

.kpi-hero-wrapper .kpi-value {
  font-size: 32px;
}

.kpi-sub { font-size: 12px; color: var(--text-muted); font-weight: 400; }

.kpi-pulse-track {
  margin-top: 12px;
  height: 4px;
  border-radius: 4px;
  background: var(--expense-bg);
  overflow: hidden;
}
.kpi-pulse-fill {
  height: 100%;
  background: var(--primary);
  border-radius: 4px;
  transition: width 0.5s ease;
}

/* ---------- Period Filter Bar ---------- */
.period-bar {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--divider);
  padding-bottom: 16px;
}

.period-presets { display: flex; gap: 8px; flex-wrap: wrap; }

.period-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; font-weight: 500;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--card-border);
  background: var(--card);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.period-chip:hover { color: var(--text); border-color: var(--text-faint); }
.period-chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #FFFFFF;
}
.custom-chip.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #FFFFFF;
}

.period-picker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.period-picker .select-wrap.small select { background: var(--card); }

.custom-range-row {
  display: flex; gap: 12px; flex-wrap: wrap;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 12px;
}
.custom-range-row .form-field { flex: 1; min-width: 140px; }

/* ---------- Comparison sub-line (inside KPI cards) ---------- */
.comparison-sub {
  display: inline-flex; align-items: center; gap: 3px;
  flex-wrap: wrap;
  font-size: 12px;
  font-weight: 500;
}
.comparison-sub.good { color: var(--income-color); }
.comparison-sub.bad { color: var(--expense-color); }
.comparison-pct { font-weight: 500; opacity: 0.85; }
.comparison-vs { color: var(--text-faint); font-weight: 500; }

/* ---------- Insights / Time Period Analysis card ---------- */
.insights-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-bottom: 20px;
  overflow: hidden;
}

.insights-toggle {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: inherit;
  color: var(--text);
}
.insights-toggle-label {
  display: inline-flex; align-items: center; gap: 8px;
  font-size: 14px; font-weight: 700;
  font-family: 'Outfit', sans-serif;
}
.insights-toggle-label svg { color: #4ADE80; }

.chevron-rotate { transition: transform 0.2s ease; color: var(--text-faint); }
.chevron-rotate.open { transform: rotate(180deg); }

.insights-body { padding: 0 18px 20px; border-top: 1px solid var(--divider); }

.insights-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  padding-top: 16px;
  margin-bottom: 22px;
}

.insight-stat {
  display: flex; align-items: flex-start; gap: 10px;
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 12px 14px;
}
.insight-icon {
  width: 26px; height: 26px; flex-shrink: 0;
  border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
}
.insight-icon.tone-income { background: var(--income-bg); color: var(--income-color); }
.insight-icon.tone-expense { background: var(--expense-bg); color: var(--expense-color); }
.insight-icon.tone-balance { background: var(--balance-bg); color: var(--balance-color); }

.insight-stat-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.insight-label { font-size: 11.5px; color: var(--text-faint); font-weight: 600; }
.insight-value {
  font-family: 'Outfit', sans-serif;
  font-size: 16px; font-weight: 700;
  font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.insight-detail {
  font-size: 11.5px; color: var(--text-muted); font-weight: 500;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ---------- Yearly View ---------- */
.yearly-view-header { margin-bottom: 10px; }
.yearly-view-header h4 {
  font-family: 'Outfit', sans-serif;
  font-size: 13.5px; font-weight: 700;
  color: var(--text-muted);
  margin: 0;
}

.yearly-table-scroll { overflow-x: auto; border: 1px solid var(--card-border); border-radius: 12px; }
.yearly-table { width: 100%; border-collapse: collapse; min-width: 460px; }
.yearly-table thead tr { border-bottom: 1px solid var(--divider); }
.yearly-table th {
  text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--text-faint); font-weight: 600; padding: 10px 14px;
}
.yearly-table td { padding: 9px 14px; font-size: 13px; border-bottom: 1px solid var(--divider); }
.yearly-table tbody tr:last-child td { border-bottom: none; }
.yearly-table tbody tr.empty-month { opacity: 0.45; }
.yearly-table tfoot tr { border-top: 1px solid var(--card-border); font-weight: 700; }
.yearly-table tfoot td { padding: 11px 14px; font-size: 13px; }
.yearly-table .cell-amount { text-align: right; font-family: 'Outfit', sans-serif; font-variant-numeric: tabular-nums; font-weight: 600; }
.yearly-table .cell-amount.income { color: var(--income-color); }
.yearly-table .cell-amount.expense { color: var(--expense-color); }

/* ---------- Toolbar ---------- */
.toolbar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; flex-wrap: wrap;
  margin-bottom: 16px;
}

.search-box {
  flex: 1; min-width: 220px;
  display: flex; align-items: center; gap: 9px;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  color: var(--text-faint);
}
.search-box input {
  flex: 1; border: none; background: transparent; outline: none;
  color: var(--text); font-size: 13.5px; font-family: inherit;
}
.search-box input::placeholder { color: var(--text-faint); }

.filter-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.select-wrap {
  position: relative;
  display: flex; align-items: center;
}
.select-wrap select {
  appearance: none;
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 10px 30px 10px 14px;
  font-size: 13px; font-weight: 500;
  color: var(--text);
  cursor: pointer;
  font-family: inherit;
}
.select-wrap.small select { padding: 9px 28px 9px 12px; font-size: 12.5px; }
.select-wrap.small .filter-icon { position: absolute; left: 10px; color: var(--text-faint); pointer-events: none; }
.select-wrap.small:has(.filter-icon) select { padding-left: 30px; }
.select-chevron { position: absolute; right: 10px; color: var(--text-faint); pointer-events: none; }

.sort-btn, .clear-btn { font-size: 12.5px; padding: 9px 13px; }

/* ---------- Bulk Action Bar ---------- */
.bulk-action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: var(--input-bg);
  border-bottom: 1px solid var(--divider);
  gap: 12px;
  flex-wrap: wrap;
}
.bulk-info {
  font-size: 13.5px;
  color: var(--text-muted);
}
.bulk-info strong {
  color: var(--text);
}
.bulk-buttons {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row-selected {
  background: rgba(99, 102, 241, 0.05) !important;
}
.row-selected:hover {
  background: rgba(99, 102, 241, 0.08) !important;
}
.th-checkbox, .cell-checkbox {
  width: 44px;
  padding: 14px 0 14px 18px !important;
  text-align: center;
  vertical-align: middle;
}
.th-checkbox input[type="checkbox"], .cell-checkbox input[type="checkbox"] {
  cursor: pointer;
  width: 15px;
  height: 15px;
  accent-color: var(--primary);
}

.danger-btn {
  color: var(--expense-color) !important;
  border-color: rgba(244, 63, 94, 0.2) !important;
}
.danger-btn:hover {
  background: rgba(244, 63, 94, 0.05) !important;
  border-color: var(--expense-color) !important;
}

/* ---------- Table ---------- */
.table-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.table-scroll { overflow-x: auto; }

table { width: 100%; border-collapse: collapse; min-width: 640px; }

thead tr { border-bottom: 1px solid var(--divider); }
th {
  text-align: left;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  font-weight: 600;
  padding: 14px 18px;
  white-space: nowrap;
}
.th-amount { text-align: right; }
.th-actions { text-align: right; }

.sortable-th {
  cursor: pointer;
  user-select: none;
  transition: color 0.15s ease;
}
.sortable-th:hover {
  color: var(--text);
}
.th-content {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.th-content.th-amount {
  justify-content: flex-end;
  width: 100%;
}

.pagination-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-top: 1px solid var(--divider);
  flex-wrap: wrap;
  gap: 12px;
}
.pagination-info {
  font-size: 13px;
  color: var(--text-muted);
}
.pagination-info strong {
  color: var(--text);
}
.pagination-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.page-size-select select {
  padding-top: 6px !important;
  padding-bottom: 6px !important;
  font-size: 12.5px !important;
}
.page-nav {
  display: flex;
  align-items: center;
  gap: 12px;
}
.page-nav-indicator {
  font-size: 13px;
  color: var(--text-muted);
}
.page-nav-indicator strong {
  color: var(--text);
}
.page-nav-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--card-border);
  background: var(--card);
}
.page-nav-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

thead tr { border-bottom: 1px solid var(--divider); position: sticky; top: 0; background: var(--card); z-index: 5; }

tbody tr { border-bottom: 1px solid var(--divider); transition: background 0.12s ease; }
tbody tr:last-child { border-bottom: none; }
tbody tr:hover { background: var(--table-row-hover); }

td { padding: 13px 18px; font-size: 13.5px; vertical-align: middle; }
.cell-date { color: var(--text-muted); white-space: nowrap; font-size: 13px; }
.cell-desc { font-weight: 500; max-width: 260px; position: relative; }
.cell-pay { color: var(--text-muted); font-size: 13px; white-space: nowrap; }
.notes-dot {
  display: inline-block;
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--primary);
  margin-left: 6px;
  vertical-align: middle;
}
.cell-amount { text-align: right; font-weight: 700; font-family: 'Outfit', sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cell-amount.income { color: var(--income-color); }
.cell-amount.expense { color: var(--expense-color); }
.cell-actions { text-align: right; white-space: nowrap; }
.cell-actions .icon-btn { width: 30px; height: 30px; margin-left: 6px; }

.cat-badge {
  display: inline-flex; align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 600;
  white-space: nowrap;
}

.type-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 12px; font-weight: 600;
  white-space: nowrap;
}
.type-chip.income { color: var(--income-color); }
.type-chip.expense { color: var(--expense-color); }

/* ---------- Empty state ---------- */
.empty-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  padding: 64px 24px;
  color: var(--text-faint);
  gap: 6px;
}
.empty-state h4 { color: var(--text); font-size: 15px; font-weight: 600; margin: 8px 0 2px; }
.empty-state p { font-size: 13px; max-width: 320px; margin: 0 0 14px; }

/* ---------- Footer ---------- */
.app-footer {
  text-align: center;
  margin-top: 22px;
  font-size: 12px;
  color: var(--text-faint);
}

/* ---------- Auth: Login / Setup Screen ---------- */
.auth-shell {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
}

.auth-card-wrap {
  position: relative;
  width: 100%;
  max-width: 420px;
}

.auth-theme-toggle {
  position: absolute;
  top: -52px;
  right: 0;
}

.auth-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 20px;
  padding: 32px 28px 26px;
  box-shadow: var(--shadow);
  animation: slideUp 0.25s ease;
}

.auth-brand { margin-bottom: 22px; }
.auth-brand .brand-mark { width: 42px; height: 42px; border-radius: 13px; }

.auth-heading {
  font-family: 'Outfit', sans-serif;
  font-size: 21px;
  font-weight: 700;
  margin: 0 0 6px;
  letter-spacing: -0.01em;
}
.auth-subheading {
  font-size: 13.5px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 0 0 22px;
}

.auth-form { display: flex; flex-direction: column; gap: 16px; }

.input-with-icon {
  display: flex; align-items: center; gap: 9px;
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  padding: 0 12px;
  transition: border-color 0.15s ease;
}
.input-with-icon:focus-within { border-color: #4ADE80; }
.input-with-icon svg:first-child { color: var(--text-faint); flex-shrink: 0; }
.input-with-icon input {
  flex: 1;
  border: none; background: transparent; outline: none;
  padding: 10px 0;
  font-size: 13.5px;
  color: var(--text);
  font-family: inherit;
}
.input-icon-btn {
  display: flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  padding: 4px;
  flex-shrink: 0;
}
.input-icon-btn:hover { color: var(--text-muted); }

.auth-error {
  display: flex; align-items: flex-start; gap: 7px;
  background: rgba(248,113,113,0.1);
  border: 1px solid rgba(248,113,113,0.3);
  color: #F87171;
  font-size: 12.5px;
  font-weight: 500;
  padding: 10px 12px;
  border-radius: 10px;
  line-height: 1.4;
}

.auth-submit { width: 100%; padding: 11px 0; font-size: 14px; margin-top: 2px; }
.auth-submit:disabled { opacity: 0.7; cursor: not-allowed; }

.auth-footnote {
  display: flex; align-items: center; gap: 6px;
  justify-content: center;
  margin-top: 20px;
  font-size: 11.5px;
  color: var(--text-faint);
  text-align: center;
}
.auth-footnote svg { flex-shrink: 0; color: #4ADE80; }

.logout-btn:hover { color: #F87171; border-color: #F87171; }

/* ---------- Modal ---------- */
.modal-overlay {
  position: fixed; inset: 0;
  background: rgba(5,7,12,0.6);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  z-index: 100;
  animation: fadeIn 0.15s ease;
}

.modal-card {
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: 18px;
  width: 100%; max-width: 440px;
  padding: 22px;
  box-shadow: 0 24px 60px -16px rgba(0,0,0,0.5);
  animation: slideUp 0.18s ease;
}
.confirm-card { max-width: 380px; }
.confirm-card h3 { margin: 0 0 8px; font-family: 'Outfit', sans-serif; font-size: 17px; }
.confirm-card p { font-size: 13.5px; color: var(--text-muted); line-height: 1.5; margin: 0 0 18px; }

.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.modal-header h3 { font-family: 'Outfit', sans-serif; font-size: 17px; font-weight: 700; margin: 0; }

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes slideUp { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

/* ---------- Form ---------- */
.txn-form { display: flex; flex-direction: column; gap: 14px; }

.type-toggle {
  display: flex; gap: 8px;
  background: var(--input-bg);
  padding: 4px; border-radius: 12px;
}
.type-btn {
  flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 0;
  border-radius: 9px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px; font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.type-btn.active.income { background: rgba(74,222,128,0.15); color: #4ADE80; }
.type-btn.active.expense { background: rgba(248,113,113,0.15); color: #F87171; }

.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

.form-field { display: flex; flex-direction: column; gap: 6px; }
.form-field label { font-size: 12.5px; font-weight: 600; color: var(--text-muted); }
.form-field input {
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13.5px;
  color: var(--text);
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s ease;
}
.form-field textarea {
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13.5px;
  color: var(--text);
  outline: none;
  font-family: inherit;
  resize: vertical;
  min-height: 44px;
  transition: border-color 0.15s ease;
}
.form-field textarea:focus { border-color: #4ADE80; }
.label-optional { color: var(--text-faint); font-weight: 500; text-transform: none; }
.theme-dark .form-field input { color-scheme: dark; }
.theme-light .form-field input { color-scheme: light; }
.form-field input:focus { border-color: #4ADE80; }
.form-field input.err { border-color: #F87171; }
.field-err { font-size: 11.5px; color: #F87171; font-weight: 500; }

.form-field .select-wrap select { width: 100%; padding: 10px 30px 10px 12px; border-radius: 10px; background: var(--input-bg); }

.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }

/* ---------- Responsive ---------- */
@media (max-width: 900px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 640px) {
  .app-shell { padding: 16px 14px 50px; }
  .kpi-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
  .kpi-card { padding: 14px; }
  .kpi-value { font-size: 21px; }
  .add-btn span, .csv-btn span { display: none; }
  .add-btn, .csv-btn { padding: 10px 13px; }
  .form-row { grid-template-columns: 1fr; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .filter-group { justify-content: space-between; }
  .filter-group .select-wrap { flex: 1; }
  .filter-group .select-wrap select { width: 100%; }
  td, th { padding: 11px 12px; }
  .cell-desc { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cell-pay { display: none; }
  .period-presets { gap: 6px; }
  .period-chip { padding: 7px 11px; font-size: 12px; }
  .period-picker .select-wrap.small select { padding: 8px 26px 8px 10px; }
  .insights-toggle { padding: 14px; }
  .insights-body { padding: 0 14px 16px; }
  .insights-grid { grid-template-columns: 1fr 1fr; }
}

@media (max-width: 420px) {
  .kpi-grid { grid-template-columns: 1fr; }
  .brand-sub { display: none; }
  .insights-grid { grid-template-columns: 1fr; }
  .auth-card { padding: 26px 20px 22px; }
  .auth-theme-toggle { top: -48px; }
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
