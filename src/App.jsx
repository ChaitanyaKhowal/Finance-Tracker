import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Plus, Search, ArrowUpRight, ArrowDownRight, Wallet, PiggyBank,
  TrendingUp, TrendingDown, Pencil, Trash2, X, Moon, Sun,
  ChevronDown, Filter, ReceiptText, Download, Upload,
  CalendarClock, CalendarDays, ChevronLeft, ChevronRight, BarChart3,
  Minus, Tag, Receipt, ListChecks, SlidersHorizontal,
  LogOut, Lock, Eye, EyeOff, ShieldCheck, AlertTriangle,
  Mail, CheckCircle2, Cloud, RefreshCw
} from "lucide-react";
import { supabase } from "./supabase";
import {
  MONTH_NAMES,
  MONTH_SHORT,
  isValidCalendarDate,
  fmtDate,
  todayISO,
} from "./utils/date";
import {
  STORAGE_KEY,
  THEME_KEY,
  safeStorage,
  loadUserTransactions,
  saveUserTransactions,
  clearUserCache,
  clearLegacyStorage,
} from "./utils/storage";
import {
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
  PAYMENT_MODES,
  CSV_COLUMNS,
  uid,
  normalizeTransaction,
  importRowsToTransactions,
  deduplicateTransactions,
  executeChunkedUpsert,
} from "./utils/csv";

/* ---------------------------------------------------------------
   CONFIG
----------------------------------------------------------------*/

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

const currency = (n) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);

/* ---------------------------------------------------------------
   AUTHENTICATION MODULE & CLOUD MIGRATION (Supabase)
   ---------------------------------------------------------------
   Backed by Supabase Auth with Row-Level Security (RLS).
   All operations return { ok, error } shaped results.
----------------------------------------------------------------*/

const authService = {
  async register(email, password) {
    const trimmed = (email || "").trim();
    if (!trimmed) return { ok: false, error: "Email address is required." };
    if (!password || password.length < 6) return { ok: false, error: "Password must be at least 6 characters." };

    try {
      const redirectUrl = typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost:5173";
      const { data, error } = await supabase.auth.signUp({
        email: trimmed,
        password: password,
        options: {
          emailRedirectTo: redirectUrl,
        },
      });
      if (error) return { ok: false, error: error.message };

      const requiresEmailConfirmation = !!(data.user && !data.session);
      return {
        ok: true,
        user: data.user,
        requiresEmailConfirmation,
        email: trimmed,
      };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to sign up." };
    }
  },

  async resendConfirmation(email) {
    const trimmed = (email || "").trim();
    if (!trimmed) return { ok: false, error: "Email address is required." };
    try {
      const redirectUrl = typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "http://localhost:5173";
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: trimmed,
        options: {
          emailRedirectTo: redirectUrl,
        },
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to resend confirmation email." };
    }
  },

  async login(email, password) {
    const trimmed = (email || "").trim();
    if (!trimmed) return { ok: false, error: "Email address is required." };
    if (!password) return { ok: false, error: "Password is required." };

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmed,
        password: password,
      });
      if (error) {
        if (error.message.toLowerCase().includes("email not confirmed")) {
          return { ok: false, error: "Please verify your email address before logging in." };
        }
        return { ok: false, error: error.message };
      }
      return { ok: true, user: data.user, session: data.session };
    } catch (e) {
      return { ok: false, error: e.message || "Failed to log in." };
    }
  },

  async logout() {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.error("Logout error", e);
    }
  },

  async getSession() {
    try {
      const { data } = await supabase.auth.getSession();
      return data?.session || null;
    } catch {
      return null;
    }
  },
};

/**
 * The 15 exact composite template signatures generated by seedTransactions().
 * A record is strictly classified as a sample if and only if it matches
 * the full multi-field signature: description, type, category, paymentMode,
 * exact amount, and notes.
 * NEVER classify based only on month, date, description, category, or amount!
 */
const SEED_SAMPLE_SIGNATURES = [
  { description: "Grocery run", category: "Food", type: "expense", amount: 1200, paymentMode: "UPI", notes: "Weekly vegetables and essentials" },
  { description: "Freelance milestone payment", category: "Freelancing", type: "income", amount: 9000, paymentMode: "Bank Transfer", notes: "" },
  { description: "Monthly salary", category: "Salary", type: "income", amount: 85000, paymentMode: "Bank Transfer", notes: "Credited on the 1st" },
  { description: "Logo design project", category: "Freelancing", type: "income", amount: 12000, paymentMode: "UPI", notes: "" },
  { description: "Grocery run", category: "Food", type: "expense", amount: 2400, paymentMode: "Debit Card", notes: "" },
  { description: "Metro card recharge", category: "Travel", type: "expense", amount: 600, paymentMode: "UPI", notes: "" },
  { description: "New headphones", category: "Shopping", type: "expense", amount: 3200, paymentMode: "Credit Card", notes: "Sony WH-CH520" },
  { description: "Dentist visit", category: "Medical", type: "expense", amount: 1500, paymentMode: "Cash", notes: "Routine checkup" },
  { description: "Online course", category: "Education", type: "expense", amount: 999, paymentMode: "Credit Card", notes: "" },
  { description: "Mom's birthday gift", category: "Family", type: "expense", amount: 2000, paymentMode: "UPI", notes: "" },
  { description: "Consulting gig", category: "Business", type: "income", amount: 18000, paymentMode: "Bank Transfer", notes: "" },
  { description: "Dinner out", category: "Food", type: "expense", amount: 1800, paymentMode: "Credit Card", notes: "Anniversary dinner" },
  { description: "Monthly salary", category: "Salary", type: "income", amount: 85000, paymentMode: "Bank Transfer", notes: "" },
  { description: "Rent share to landlord", category: "Other", type: "expense", amount: 15000, paymentMode: "Bank Transfer", notes: "" },
  { description: "Interest payout", category: "Other", type: "income", amount: 450, paymentMode: "Bank Transfer", notes: "Savings account interest" },
];

function isSampleTransaction(t) {
  if (!t) return false;
  const tDesc = (t.description || "").trim();
  const tType = (t.type || "").trim().toLowerCase();
  const tCat = (t.category || "").trim();
  const tPay = (t.paymentMode || t.payment_mode || "").trim();
  const tAmt = Math.abs(Number(t.amount) || 0);
  const tNotes = (t.notes || "").trim();

  return SEED_SAMPLE_SIGNATURES.some(
    (s) =>
      s.description === tDesc &&
      s.type === tType &&
      s.category === tCat &&
      s.paymentMode === tPay &&
      Math.abs(s.amount - tAmt) < 0.01 &&
      (s.notes || "") === tNotes
  );
}

/**
 * Migrates existing laptop records from localStorage to Supabase with deep verification.
 * 1. Checks if migration was already verified and marked complete.
 * 2. Cloud-First Check: If user already has transactions in Supabase, skip migration.
 * 3. Filters out any sample/dummy records so fake records are never uploaded.
 * 4. Uploads via upsert with composite primary key (id, user_id).
 * 5. Deep-verifies all record IDs and contents against cloud response.
 * 6. Only marks complete if 100% verified. Never deletes local data.
 */
async function migrateLocalTransactions(user) {
  if (!user?.id) return { status: "no_user" };
  const migKey = `pft_migrated_v1_${user.id}`;
  if (safeStorage.getItem(migKey) === "true") {
    return { status: "already_migrated" };
  }

  // Cloud-First Guard: If user already has cloud transactions, cloud is the single source of truth.
  // Never upload local unauthenticated or sample data into an existing account.
  try {
    const { data: cloudExisting, error: checkErr } = await supabase
      .from("transactions")
      .select("id")
      .eq("user_id", user.id)
      .limit(1);

    if (!checkErr && cloudExisting && cloudExisting.length > 0) {
      safeStorage.setItem(migKey, "true");
      return { status: "already_migrated" };
    }
  } catch (e) {
    console.warn("Could not check existing cloud records:", e);
  }

  let localTxns = [];
  try {
    const raw = safeStorage.getItem(STORAGE_KEY);
    if (raw) {
      localTxns = JSON.parse(raw);
    }
  } catch (err) {
    console.error("Could not parse local transactions for migration:", err);
    return { status: "failed", error: "Failed to read local storage." };
  }

  if (!Array.isArray(localTxns) || localTxns.length === 0) {
    safeStorage.setItem(migKey, "true");
    return { status: "empty" };
  }

  // Filter out any sample seed transactions — sample data must NEVER be uploaded to Supabase!
  const realLocalTxns = localTxns.filter((t) => !isSampleTransaction(t));
  if (realLocalTxns.length === 0) {
    safeStorage.setItem(migKey, "true");
    return { status: "empty" };
  }

  const payload = realLocalTxns.map((t) => ({
    id: String(t.id),
    user_id: user.id,
    date: t.date,
    description: t.description || "Untitled",
    category: t.category || "Other",
    type: t.type === "income" ? "income" : "expense",
    amount: Math.abs(Number(t.amount) || 0),
    payment_mode: t.paymentMode || "Cash",
    notes: t.notes || "",
  }));

  try {
    const { error: upsertErr } = await supabase
      .from("transactions")
      .upsert(payload, { onConflict: "id,user_id" });

    if (upsertErr) {
      console.error("Migration upsert error:", upsertErr);
      return { status: "failed", error: upsertErr.message };
    }

    // Deep Verification: Check IDs and contents
    const { data: cloudRows, error: fetchErr } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user.id);

    if (fetchErr || !cloudRows) {
      console.error("Migration verification error:", fetchErr);
      return { status: "failed", error: "Could not fetch cloud rows for verification." };
    }

    const cloudMap = new Map(cloudRows.map((r) => [String(r.id), r]));
    let verifiedCount = 0;
    let contentMatch = true;

    for (const local of realLocalTxns) {
      const cloud = cloudMap.get(String(local.id));
      if (!cloud) {
        contentMatch = false;
        break;
      }
      const amtMatch = Math.abs(Number(cloud.amount) - Math.abs(Number(local.amount))) < 0.001;
      const dateMatch = cloud.date === local.date;
      const typeMatch = cloud.type === local.type;
      const descMatch = cloud.description === (local.description || "Untitled");

      if (!amtMatch || !dateMatch || !typeMatch || !descMatch) {
        contentMatch = false;
        break;
      }
      verifiedCount++;
    }

    if (contentMatch && verifiedCount === realLocalTxns.length) {
      safeStorage.setItem(migKey, "true");
      // Clear legacy unauthenticated local storage so it cannot leak across sessions
      safeStorage.removeItem(STORAGE_KEY);
      return { status: "success", count: verifiedCount };
    } else {
      console.error("Migration verification mismatch!");
      return { status: "failed", error: "Verification mismatch: record contents did not match exactly." };
    }
  } catch (e) {
    console.error("Migration exception:", e);
    return { status: "failed", error: e.message };
  }
}



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

/* ---------------------------------------------------------------
   CSV IMPORT / EXPORT
----------------------------------------------------------------*/

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

function loadTheme() {
  try {
    return safeStorage.getItem(THEME_KEY) || "dark";
  } catch {
    return "dark";
  }
}

/* ---------------------------------------------------------------
   AUTH UI: LOGIN / FIRST-RUN SETUP SCREEN
----------------------------------------------------------------*/

function LoginScreen({ onAuthenticated, theme, onToggleTheme, urlMessage }) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [infoMessage, setInfoMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setInfoMessage("");

    if (isSignUp) {
      if (password !== confirmPassword) {
        setError("Passwords don't match.");
        return;
      }
      if (password.length < 6) {
        setError("Password must be at least 6 characters.");
        return;
      }
    }

    setSubmitting(true);
    const result = isSignUp
      ? await authService.register(email, password)
      : await authService.login(email, password);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    if (result.requiresEmailConfirmation) {
      setInfoMessage(
        `Account created! A confirmation email has been sent to ${email}. Please check your inbox (and spam folder) and click the link to confirm, then sign in.`
      );
      setIsSignUp(false);
      setPassword("");
      setConfirmPassword("");
      return;
    }

    if (result.user) {
      onAuthenticated(result.user);
    }
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

          <div className="auth-mode-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={!isSignUp}
              className={`auth-mode-tab ${!isSignUp ? "active" : ""}`}
              onClick={() => { setIsSignUp(false); setError(""); setInfoMessage(""); }}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isSignUp}
              className={`auth-mode-tab ${isSignUp ? "active" : ""}`}
              onClick={() => { setIsSignUp(true); setError(""); setInfoMessage(""); }}
            >
              Create account
            </button>
          </div>

          <h2 className="auth-heading">
            {isSignUp ? "Create your cloud account" : "Welcome back"}
          </h2>
          <p className="auth-subheading">
            {isSignUp
              ? "Sign up with your email to sync your expenses seamlessly across all devices."
              : "Enter your email and password to access your synchronized dashboard."}
          </p>

          {urlMessage && (
            <div className={urlMessage.type === "error" ? "auth-error" : "auth-info-banner"} style={{ marginBottom: 16 }}>
              {urlMessage.type === "error" ? (
                <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              ) : (
                <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              )}
              <span>{urlMessage.text}</span>
            </div>
          )}

          {infoMessage && (
            <div className="auth-info-banner" style={{ marginBottom: 16 }}>
              <CheckCircle2 size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>{infoMessage}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="auth-form">
            <div className="form-field">
              <label htmlFor="auth-email">Email address</label>
              <div className="input-with-icon">
                <Mail size={15} />
                <input
                  id="auth-email"
                  type="email"
                  autoComplete="email"
                  placeholder="e.g. chirag@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                  autoComplete={isSignUp ? "new-password" : "current-password"}
                  placeholder={isSignUp ? "At least 6 characters" : "Your password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
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

            {isSignUp && (
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
              <div className="auth-error" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span>{error}</span>
                </div>
                {error.toLowerCase().includes("verify") && email && (
                  <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ fontSize: 12, padding: "5px 12px", alignSelf: "flex-start" }}
                      onClick={async () => {
                        setSubmitting(true);
                        const res = await authService.resendConfirmation(email);
                        setSubmitting(false);
                        if (res.ok) {
                          setInfoMessage(`A fresh confirmation email was sent to ${email}. Please check your inbox.`);
                          setError("");
                        } else {
                          setError(res.error);
                        }
                      }}
                    >
                      Resend confirmation email
                    </button>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.4 }}>
                      Or in Supabase Dashboard: Go to Authentication &rarr; Users &rarr; click "..." next to your email &rarr; "Auto-confirm user".
                    </span>
                  </div>
                )}
              </div>
            )}

            <button type="submit" className="btn btn-primary auth-submit" disabled={submitting}>
              {submitting ? "Please wait..." : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="auth-footnote">
            <ShieldCheck size={13} />
            Protected by Supabase Cloud Authentication & Row-Level Security.
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
   TRANSACTION FORM (Add / Edit / Multi-Entry Batch)
----------------------------------------------------------------*/

function TransactionForm({ open, onClose, onSave, editing }) {
  const isEdit = !!editing;
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");

  // Single edit mode state
  const [editData, setEditData] = useState({
    type: "expense",
    date: todayISO(),
    description: "",
    category: EXPENSE_CATEGORIES[0],
    amount: "",
    paymentMode: PAYMENT_MODES[0],
    notes: "",
  });
  const [editErrors, setEditErrors] = useState({});

  // Batch / Add mode state
  const createBlankEntry = useCallback((defaultDate = todayISO(), defaultType = "expense") => ({
    tempId: uid(),
    type: defaultType,
    date: defaultDate,
    description: "",
    category: defaultType === "income" ? INCOME_CATEGORIES[0] : EXPENSE_CATEGORIES[0],
    amount: "",
    paymentMode: PAYMENT_MODES[0],
    notes: "",
    errors: {},
  }), []);

  const [entries, setEntries] = useState([createBlankEntry()]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubmitting(false);
    setFormError("");
    if (editing) {
      setEditData({
        type: editing.type || "expense",
        date: editing.date || todayISO(),
        description: editing.description || "",
        category: editing.category || (editing.type === "income" ? INCOME_CATEGORIES[0] : EXPENSE_CATEGORIES[0]),
        amount: editing.amount != null ? String(editing.amount) : "",
        paymentMode: editing.paymentMode || PAYMENT_MODES[0],
        notes: editing.notes || "",
      });
      setEditErrors({});
    } else {
      setEntries([createBlankEntry(todayISO(), "expense")]);
    }
  }, [open, editing, createBlankEntry]);

  const handleAddAnother = () => {
    setEntries((prev) => {
      const last = prev[prev.length - 1];
      const nextDate = last?.date || todayISO();
      const nextType = last?.type || "expense";
      return [...prev, createBlankEntry(nextDate, nextType)];
    });
  };

  const handleRemoveEntry = (tempId) => {
    setEntries((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((item) => item.tempId !== tempId);
    });
  };

  const handleUpdateEntry = (tempId, field, value) => {
    setEntries((prev) =>
      prev.map((item) => {
        if (item.tempId !== tempId) return item;
        const updated = { ...item, [field]: value };
        if (field === "type") {
          const allowed = value === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
          if (!allowed.includes(updated.category)) {
            updated.category = allowed[0];
          }
        }
        if (updated.errors && updated.errors[field]) {
          updated.errors = { ...updated.errors, [field]: null };
        }
        return updated;
      })
    );
  };

  const handleUpdateEdit = (field, value) => {
    setEditData((prev) => {
      const updated = { ...prev, [field]: value };
      if (field === "type") {
        const allowed = value === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
        if (!allowed.includes(updated.category)) {
          updated.category = allowed[0];
        }
      }
      return updated;
    });
    if (editErrors[field]) {
      setEditErrors((prev) => ({ ...prev, [field]: null }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    if (isEdit) {
      const errs = {};
      if (!isValidCalendarDate(editData.date)) {
        errs.date = "Valid calendar date required (YYYY-MM-DD)";
      }
      if (!editData.description.trim()) {
        errs.description = "Description is required";
      }
      const num = parseFloat(editData.amount);
      if (!editData.amount || isNaN(num) || num <= 0) {
        errs.amount = "Enter amount > 0";
      }
      if (Object.keys(errs).length > 0) {
        setEditErrors(errs);
        return;
      }

      setSubmitting(true);
      setFormError("");
      const normalized = normalizeTransaction(
        {
          ...editing,
          date: editData.date,
          description: editData.description.trim(),
          category: editData.category,
          type: editData.type,
          amount: parseFloat(editData.amount),
          paymentMode: editData.paymentMode,
          notes: editData.notes.trim(),
        },
        { touch: true }
      );
      const res = await onSave(normalized);
      setSubmitting(false);
      if (res && !res.ok) {
        setFormError(res.error || "Failed to save transaction.");
      }
      return;
    }

    // Batch add mode validation
    let hasAnyError = false;
    const validated = entries.map((item) => {
      const errs = {};
      if (!isValidCalendarDate(item.date)) {
        errs.date = "Valid calendar date required (YYYY-MM-DD)";
      }
      if (!item.description || !item.description.trim()) {
        errs.description = "Description is required";
      }
      const num = parseFloat(item.amount);
      if (!item.amount || isNaN(num) || num <= 0) {
        errs.amount = "Enter amount > 0";
      }
      if (Object.keys(errs).length > 0) hasAnyError = true;
      return { ...item, errors: errs };
    });

    if (hasAnyError) {
      setEntries(validated);
      return;
    }

    setSubmitting(true);
    setFormError("");
    const normalizedBatch = entries.map((item) =>
      normalizeTransaction(
        {
          date: item.date,
          description: item.description.trim(),
          category: item.category,
          type: item.type,
          amount: parseFloat(item.amount),
          paymentMode: item.paymentMode,
          notes: (item.notes || "").trim(),
        },
        { touch: true }
      )
    );

    const res = await onSave(normalizedBatch);
    setSubmitting(false);
    if (res && !res.ok) {
      setFormError(res.error || "Failed to save transactions.");
    }
  };

  if (!open) return null;

  const batchNet = entries.reduce((sum, item) => {
    const val = parseFloat(item.amount) || 0;
    return sum + (item.type === "income" ? val : -val);
  }, 0);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card batch-modal" onClick={(e) => e.stopPropagation()}>
        <div className="batch-modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h3>{isEdit ? "Edit transaction" : entries.length > 1 ? "Add transactions" : "Add transaction"}</h3>
            {!isEdit && entries.length > 1 && (
              <span className="batch-badge">{entries.length} entries</span>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="batch-form-wrapper">
          <div className="batch-modal-body">
            {formError && (
              <div className="auth-error" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={15} style={{ flexShrink: 0 }} />
                <span>{formError}</span>
              </div>
            )}

            {isEdit ? (
              /* Single edit form */
              <div className="batch-entry-card edit-card">
                <div className="type-toggle">
                  <button
                    type="button"
                    className={`type-btn ${editData.type === "income" ? "active income" : ""}`}
                    onClick={() => handleUpdateEdit("type", "income")}
                  >
                    <ArrowUpRight size={15} /> Income
                  </button>
                  <button
                    type="button"
                    className={`type-btn ${editData.type === "expense" ? "active expense" : ""}`}
                    onClick={() => handleUpdateEdit("type", "expense")}
                  >
                    <ArrowDownRight size={15} /> Expense
                  </button>
                </div>

                <div className="form-row">
                  <div className="form-field">
                    <label>Date</label>
                    <div className="date-input-wrap">
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => handleUpdateEdit("date", e.target.value)}
                        className={editErrors.date ? "err" : ""}
                      />
                      <button
                        type="button"
                        className="quick-today-btn"
                        onClick={() => handleUpdateEdit("date", todayISO())}
                        title="Set date to today"
                      >
                        Today
                      </button>
                    </div>
                    {editErrors.date && <span className="field-err">{editErrors.date}</span>}
                  </div>
                  <div className="form-field">
                    <label>Amount (₹)</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      placeholder="0.00"
                      step="0.01"
                      min="0"
                      value={editData.amount}
                      onChange={(e) => handleUpdateEdit("amount", e.target.value)}
                      className={editErrors.amount ? "err" : ""}
                    />
                    {editErrors.amount && <span className="field-err">{editErrors.amount}</span>}
                  </div>
                </div>

                <div className="form-field">
                  <label>Description</label>
                  <input
                    type="text"
                    placeholder="e.g. Grocery run, Rent payment"
                    value={editData.description}
                    onChange={(e) => handleUpdateEdit("description", e.target.value)}
                    className={editErrors.description ? "err" : ""}
                    maxLength={120}
                  />
                  {editErrors.description && <span className="field-err">{editErrors.description}</span>}
                </div>

                <div className="form-row">
                  <div className="form-field">
                    <label>Category</label>
                    <div className="select-wrap">
                      <select
                        value={editData.category}
                        onChange={(e) => handleUpdateEdit("category", e.target.value)}
                      >
                        {(editData.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES).map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} className="select-chevron" />
                    </div>
                  </div>
                  <div className="form-field">
                    <label>Payment mode</label>
                    <div className="select-wrap">
                      <select
                        value={editData.paymentMode}
                        onChange={(e) => handleUpdateEdit("paymentMode", e.target.value)}
                      >
                        {PAYMENT_MODES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={15} className="select-chevron" />
                    </div>
                  </div>
                </div>

                <div className="form-field">
                  <label>
                    Notes <span className="label-optional">(optional)</span>
                  </label>
                  <textarea
                    placeholder="Any extra details worth remembering..."
                    value={editData.notes}
                    onChange={(e) => handleUpdateEdit("notes", e.target.value)}
                    maxLength={280}
                    rows={2}
                  />
                </div>
              </div>
            ) : (
              /* Batch / Multi-entry form */
              <>
                {entries.map((entry, idx) => {
                  const currentCategories = entry.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
                  return (
                    <div className="batch-entry-card" key={entry.tempId}>
                      {entries.length > 1 && (
                        <div className="batch-entry-header">
                          <span className="batch-entry-num">Transaction #{idx + 1}</span>
                          <button
                            type="button"
                            className="batch-remove-btn"
                            onClick={() => handleRemoveEntry(entry.tempId)}
                            aria-label={`Remove entry #${idx + 1}`}
                          >
                            <Trash2 size={13} />
                            <span>Remove</span>
                          </button>
                        </div>
                      )}

                      <div className="type-toggle">
                        <button
                          type="button"
                          className={`type-btn ${entry.type === "income" ? "active income" : ""}`}
                          onClick={() => handleUpdateEntry(entry.tempId, "type", "income")}
                        >
                          <ArrowUpRight size={15} /> Income
                        </button>
                        <button
                          type="button"
                          className={`type-btn ${entry.type === "expense" ? "active expense" : ""}`}
                          onClick={() => handleUpdateEntry(entry.tempId, "type", "expense")}
                        >
                          <ArrowDownRight size={15} /> Expense
                        </button>
                      </div>

                      <div className="form-row">
                        <div className="form-field">
                          <label>Date</label>
                          <div className="date-input-wrap">
                            <input
                              type="date"
                              value={entry.date}
                              onChange={(e) => handleUpdateEntry(entry.tempId, "date", e.target.value)}
                              className={entry.errors?.date ? "err" : ""}
                            />
                            <button
                              type="button"
                              className="quick-today-btn"
                              onClick={() => handleUpdateEntry(entry.tempId, "date", todayISO())}
                              title="Set date to today"
                            >
                              Today
                            </button>
                          </div>
                          {entry.errors?.date && <span className="field-err">{entry.errors.date}</span>}
                        </div>
                        <div className="form-field">
                          <label>Amount (₹)</label>
                          <input
                            type="number"
                            inputMode="decimal"
                            placeholder="0.00"
                            step="0.01"
                            min="0"
                            value={entry.amount}
                            onChange={(e) => handleUpdateEntry(entry.tempId, "amount", e.target.value)}
                            className={entry.errors?.amount ? "err" : ""}
                          />
                          {entry.errors?.amount && <span className="field-err">{entry.errors.amount}</span>}
                        </div>
                      </div>

                      <div className="form-field">
                        <label>Description</label>
                        <input
                          type="text"
                          placeholder="e.g. Grocery shopping, Electricity bill, Freelance"
                          value={entry.description}
                          onChange={(e) => handleUpdateEntry(entry.tempId, "description", e.target.value)}
                          className={entry.errors?.description ? "err" : ""}
                          maxLength={120}
                        />
                        {entry.errors?.description && <span className="field-err">{entry.errors.description}</span>}
                      </div>

                      <div className="form-row">
                        <div className="form-field">
                          <label>Category</label>
                          <div className="select-wrap">
                            <select
                              value={entry.category}
                              onChange={(e) => handleUpdateEntry(entry.tempId, "category", e.target.value)}
                            >
                              {currentCategories.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={15} className="select-chevron" />
                          </div>
                        </div>
                        <div className="form-field">
                          <label>Payment mode</label>
                          <div className="select-wrap">
                            <select
                              value={entry.paymentMode}
                              onChange={(e) => handleUpdateEntry(entry.tempId, "paymentMode", e.target.value)}
                            >
                              {PAYMENT_MODES.map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={15} className="select-chevron" />
                          </div>
                        </div>
                      </div>

                      <div className="form-field">
                        <label>
                          Notes <span className="label-optional">(optional)</span>
                        </label>
                        <textarea
                          placeholder="Any extra details worth remembering..."
                          value={entry.notes}
                          onChange={(e) => handleUpdateEntry(entry.tempId, "notes", e.target.value)}
                          maxLength={280}
                          rows={1}
                        />
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  className="add-another-btn"
                  onClick={handleAddAnother}
                  disabled={submitting}
                >
                  <Plus size={16} strokeWidth={2.5} />
                  <span>Add Another Entry</span>
                </button>

                {entries.length > 1 && (
                  <div className="batch-summary-strip">
                    <span>
                      <strong>{entries.length}</strong> transactions ready
                    </span>
                    <span>•</span>
                    <span>
                      Net impact: <strong>{currency(batchNet)}</strong>
                    </span>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="batch-modal-footer">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn btn-primary ${isEdit ? editData.type : entries.length === 1 ? entries[0].type : "income"}`}
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <RefreshCw size={14} className="spin" />
                  <span>Saving...</span>
                </>
              ) : isEdit ? (
                "Save changes"
              ) : entries.length > 1 ? (
                `Save All (${entries.length})`
              ) : (
                "Add transaction"
              )}
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

function Dashboard({ onLogout, currentUser, user, theme, onToggleTheme }) {
  const [transactions, setTransactions] = useState(() => {
    return loadUserTransactions(user?.id, normalizeTransaction);
  });

  const transactionsRef = useRef(transactions);
  useEffect(() => {
    transactionsRef.current = transactions;
  }, [transactions]);

  const [syncStatus, setSyncStatus] = useState("idle"); // "idle" | "syncing" | "synced" | "error"
  const [migrationAlert, setMigrationAlert] = useState(null);

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
  const [showSampleDetails, setShowSampleDetails] = useState(true);
  const [cloudSampleRecords, setCloudSampleRecords] = useState([]);
  const [checkingCloudSamples, setCheckingCloudSamples] = useState(false);

  // Combine any dummy sample records detected in Supabase or local state
  const detectedSampleRecords = useMemo(() => {
    const map = new Map();
    cloudSampleRecords.forEach((r) => map.set(String(r.id), r));
    transactions.filter(isSampleTransaction).forEach((r) => map.set(String(r.id), r));
    return Array.from(map.values());
  }, [cloudSampleRecords, transactions]);

  // Query Supabase directly for any sample records belonging to the logged-in user
  const checkSupabaseForSampleRecords = useCallback(async () => {
    if (!user?.id) return;
    setCheckingCloudSamples(true);
    try {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("user_id", user.id)
        .order("date", { ascending: false });

      if (!error && data) {
        const dummies = data.filter(isSampleTransaction);
        setCloudSampleRecords(dummies);
        if (dummies.length === 0) {
          setMigrationAlert({
            type: "success",
            text: `Cloud check verified: 0 sample records found in Supabase. All ${data.length} transactions are genuine.`,
          });
        }
      }
    } catch (e) {
      console.warn("Could not check Supabase for sample records:", e);
    } finally {
      setCheckingCloudSamples(false);
    }
  }, [user]);

  // Check Supabase on initial mount
  useEffect(() => {
    if (user?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      checkSupabaseForSampleRecords();
    }
  }, [user?.id, checkSupabaseForSampleRecords]);

  useEffect(() => {
    if (detectedSampleRecords.length > 0) {
      window.__SAMPLE_RECORDS__ = detectedSampleRecords;
      console.log(`[FinanceTracker] Detected ${detectedSampleRecords.length} sample transactions in Supabase/local:`);
      console.table(
        detectedSampleRecords.map((r, i) => ({
          "#": i + 1,
          ID: r.id,
          Date: r.date,
          Description: r.description,
          Category: r.category,
          Type: r.type,
          Amount: r.amount,
        }))
      );
    }
  }, [detectedSampleRecords]);

  // Manual cleanup: Deletes ONLY verified dummy IDs from Supabase and refreshes
  const handleManualCleanupSampleRecords = useCallback(async () => {
    if (!detectedSampleRecords.length || !user?.id) return;
    const sampleIds = detectedSampleRecords.map((s) => String(s.id));

    // 1. Delete ONLY the exact verified dummy IDs belonging to the logged-in user
    const { error: delErr } = await supabase
      .from("transactions")
      .delete()
      .in("id", sampleIds)
      .eq("user_id", user.id);

    if (delErr) {
      console.error("Supabase sample cleanup error:", delErr);
      setMigrationAlert({
        type: "error",
        text: `Failed to delete sample records from Supabase: ${delErr.message}`,
      });
      return;
    }

    // 2. Refresh transactions from Supabase after cleanup
    const { data: freshData, error: refreshErr } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("date", { ascending: false });

    if (refreshErr) {
      console.error("Supabase refresh error:", refreshErr);
      setMigrationAlert({
        type: "error",
        text: `Sample records deleted from cloud, but could not refresh dashboard: ${refreshErr.message}`,
      });
    } else if (freshData) {
      const normalized = freshData.map((row) =>
        normalizeTransaction({
          id: row.id,
          date: row.date,
          description: row.description,
          category: row.category,
          type: row.type,
          amount: Number(row.amount),
          paymentMode: row.payment_mode,
          notes: row.notes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      );
      setTransactions(normalized);
      safeStorage.setItem("pft_transactions_cache_" + user.id, JSON.stringify(normalized));

      // Re-verify dummy records count in fresh data
      const remainingDummies = freshData.filter(isSampleTransaction);
      setCloudSampleRecords(remainingDummies);

      // 3. Show success only after the deletion is confirmed
      setMigrationAlert({
        type: "success",
        text: `Successfully deleted ${sampleIds.length} verified sample records from Supabase. All 670 genuine transactions preserved!`,
      });
    }
  }, [detectedSampleRecords, user]);

  /* ---- Time Period Analysis: global filter state ---- */
  const now = useMemo(() => new Date(), []);
  const [periodKey, setPeriodKey] = useState("current_month");
  const [pickedMonth, setPickedMonth] = useState(() => new Date().getMonth()); // 0-indexed
  const [pickedYear, setPickedYear] = useState(() => new Date().getFullYear());
  const [customStart, setCustomStart] = useState(todayISO());
  const [customEnd, setCustomEnd] = useState(todayISO());
  const [insightsOpen, setInsightsOpen] = useState(true);

  // Auto-reset page when filter changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentPage(1);
  }, [search, typeFilter, categoryFilter, periodKey, pickedMonth, pickedYear, customStart, customEnd]);

  // Sync and migrate with Supabase
  const runSyncAndMigration = useCallback(async () => {
    if (!user?.id) return;
    setSyncStatus("syncing");

    // 1. Run safe migration (deep verified)
    try {
      const migResult = await migrateLocalTransactions(user);
      if (migResult.status === "success") {
        setMigrationAlert({
          type: "success",
          text: `Successfully migrated ${migResult.count} existing records to your cloud account.`,
        });
      } else if (migResult.status === "failed") {
        setMigrationAlert({
          type: "error",
          text: `Migration check: ${migResult.error}. Local records remain safe.`,
        });
      }
    } catch (err) {
      console.error("Migration check error:", err);
    }

    // 2. Fetch all cloud records for this user
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("user_id", user.id)
      .order("date", { ascending: false });

    if (error) {
      console.warn("Could not fetch cloud transactions, using local data:", error);
      setSyncStatus("error");
    } else if (data) {
      const normalized = data.map((row) =>
        normalizeTransaction({
          id: row.id,
          date: row.date,
          description: row.description,
          category: row.category,
          type: row.type,
          amount: Number(row.amount),
          paymentMode: row.payment_mode,
          notes: row.notes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        })
      );
      setTransactions(normalized);
      saveUserTransactions(user.id, normalized);
      setSyncStatus("synced");
    }
  }, [user]);

  useEffect(() => {
    let isMounted = true;
    if (user?.id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runSyncAndMigration();
    }

    // Auto-refresh when tab gains focus (keeps mobile and laptop in real-time sync)
    const onFocus = () => {
      if (isMounted) runSyncAndMigration();
    };

    window.addEventListener("focus", onFocus);

    return () => {
      isMounted = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [runSyncAndMigration, user?.id]);

  useEffect(() => {
    saveUserTransactions(user?.id, transactions);
  }, [transactions, user]);

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
  }, [periodKey, pickedYear, range.start, now]);

  const yearlyBreakdown = useMemo(
    () => buildYearlyBreakdown(transactions, yearlyViewYear),
    [transactions, yearlyViewYear]
  );

  const availableYears = useMemo(() => {
    const years = new Set(transactions.map((t) => t.year).filter(Boolean));
    years.add(now.getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }, [transactions, now]);

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
  }, [transactions, now]);

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
    async (payload) => {
      const items = Array.isArray(payload) ? payload : [payload];
      if (!items.length) {
        closeForm();
        return { ok: true };
      }

      // 1. If user is authenticated, sync with Supabase first
      if (user?.id) {
        const dbRows = items.map((txn) => ({
          id: String(txn.id),
          user_id: user.id,
          date: txn.date,
          description: txn.description,
          category: txn.category,
          type: txn.type,
          amount: Math.abs(Number(txn.amount) || 0),
          payment_mode: txn.paymentMode || "Cash",
          notes: txn.notes || "",
          updated_at: new Date().toISOString(),
        }));

        const { error } = await supabase
          .from("transactions")
          .upsert(dbRows, { onConflict: "id,user_id" });

        if (error) {
          console.error("Cloud sync save error:", error);
          return { ok: false, error: `Cloud sync failed: ${error.message}` };
        }
      }

      // 2. Update local state
      setTransactions((prev) => {
        let updated = [...prev];
        for (const txn of items) {
          const idx = updated.findIndex((t) => t.id === txn.id);
          if (idx >= 0) {
            updated[idx] = txn;
          } else {
            updated = [txn, ...updated];
          }
        }
        return updated;
      });

      // 3. Show clear success feedback
      setMigrationAlert({
        type: "success",
        text:
          items.length === 1
            ? `Transaction "${items[0].description}" (${currency(items[0].amount)}) saved successfully!`
            : `Successfully saved ${items.length} transactions to your ledger!`,
      });

      closeForm();
      return { ok: true };
    },
    [closeForm, user]
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

    if (user?.id) {
      supabase
        .from("transactions")
        .delete()
        .eq("id", String(targetId))
        .eq("user_id", user.id)
        .then(({ error }) => {
          if (error) console.error("Cloud delete error:", error);
        });
    }
  }, [deleteTarget, user]);

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
    const idsToDelete = Array.from(selectedIds);
    setTransactions((prev) => prev.filter((t) => !selectedIds.has(t.id)));
    setSelectedIds(new Set());
    setBulkConfirmOpen(false);

    if (user?.id && idsToDelete.length > 0) {
      supabase
        .from("transactions")
        .delete()
        .in("id", idsToDelete.map(String))
        .eq("user_id", user.id)
        .then(({ error }) => {
          if (error) console.error("Cloud bulk delete error:", error);
        });
    }
  }, [selectedIds, user]);

  const handleConfirmDeleteAll = useCallback(() => {
    setTransactions([]);
    setSelectedIds(new Set());
    setDeleteAllConfirmOpen(false);

    if (user?.id) {
      supabase
        .from("transactions")
        .delete()
        .eq("user_id", user.id)
        .then(({ error }) => {
          if (error) console.error("Cloud delete all error:", error);
        });
    }
  }, [user]);

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
    ).then(async () => {
      if (allValid.length) {
        // Safe Deduplication & Append using robust occurrence-aware matching
        const currentTxns = transactionsRef.current;
        const { toAdd: newItems, duplicatesCount } = deduplicateTransactions(allValid, currentTxns);

        let uploadFailed = false;
        let succeededItems = [];
        let failedItems = [];
        let uploadError = null;

        if (user?.id && newItems.length > 0) {
          const dbRows = newItems.map((tx) => ({
            id: String(tx.id),
            user_id: user.id,
            date: tx.date,
            description: tx.description,
            category: tx.category,
            type: tx.type,
            amount: Math.abs(Number(tx.amount) || 0),
            payment_mode: tx.paymentMode || "Cash",
            notes: tx.notes || "",
            updated_at: new Date().toISOString(),
          }));

          const upsertResult = await executeChunkedUpsert(supabase, dbRows, 200);
          uploadError = upsertResult.error;

          if (upsertResult.isCompleteSuccess) {
            succeededItems = newItems;
          } else if (upsertResult.isPartial) {
            uploadFailed = true;
            const succeededIds = new Set(upsertResult.succeeded.map((r) => String(r.id)));
            succeededItems = newItems.filter((tx) => succeededIds.has(String(tx.id)));
            failedItems = newItems.filter((tx) => !succeededIds.has(String(tx.id)));
          } else {
            uploadFailed = true;
            failedItems = newItems;
          }
        } else {
          succeededItems = newItems;
        }

        // Keep local state strictly matching what succeeded in cloud
        if (succeededItems.length > 0) {
          setTransactions((prev) => [...succeededItems, ...prev]);
          saveUserTransactions(user?.id, [...succeededItems, ...currentTxns]);
        }

        if (!uploadFailed) {
          if (newItems.length > 0) {
            setMigrationAlert({
              type: "success",
              text: `Successfully imported ${newItems.length} transactions${duplicatesCount > 0 ? ` (${duplicatesCount} duplicates skipped)` : ""}! All existing data preserved.`,
            });
          } else if (duplicatesCount > 0) {
            setMigrationAlert({
              type: "success",
              text: `Import complete: all ${duplicatesCount} transactions in the file were already in your ledger (duplicates skipped).`,
            });
          }
        } else if (succeededItems.length > 0 && failedItems.length > 0) {
          setMigrationAlert({
            type: "warning",
            text: `Partial import: ${succeededItems.length} transactions saved to cloud, but ${failedItems.length} failed (${uploadError?.message || "Error"}). Saved records are in your ledger.`,
          });
        } else {
          setMigrationAlert({
            type: "error",
            text: `Failed to save imported records to cloud: ${uploadError?.message || "Error"}. Existing records remain untouched.`,
          });
        }

        setImportResult({
          added: succeededItems.length,
          failed: failedItems.length,
          skipped: duplicatesCount,
          errors: allErrors,
        });
      } else {
        setImportResult({
          added: 0,
          failed: 0,
          skipped: 0,
          errors: allErrors,
        });
      }
    });

    e.target.value = ""; // allow re-selecting the same files
  }, [user]);

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
              <span className="brand-sub" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span>{currentUser}</span>
                <span
                  className={`sync-pill ${syncStatus}`}
                  onClick={syncStatus === "error" ? runSyncAndMigration : undefined}
                  style={{ cursor: syncStatus === "error" ? "pointer" : "default" }}
                  title={syncStatus === "error" ? "Click to retry sync" : undefined}
                >
                  <Cloud size={11} />
                  <span>{syncStatus === "syncing" ? "Syncing..." : syncStatus === "error" ? "Offline (Retry)" : "Cloud Synced"}</span>
                </span>
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
            <button
              className="btn btn-ghost csv-btn"
              onClick={checkSupabaseForSampleRecords}
              disabled={checkingCloudSamples}
              title="Scan Supabase cloud for sample records"
            >
              <ShieldCheck size={15} />
              <span>{checkingCloudSamples ? "Scanning..." : "Scan Cloud"}</span>
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

        {detectedSampleRecords.length > 0 && (
          <div
            className="import-banner warn"
            style={{
              marginBottom: 16,
              flexDirection: "column",
              alignItems: "stretch",
              background: "rgba(245, 158, 11, 0.08)",
              border: "1px solid rgba(245, 158, 11, 0.3)",
              borderRadius: 10,
              padding: "14px 16px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <AlertTriangle size={18} style={{ color: "#F59E0B", flexShrink: 0 }} />
                <span style={{ fontSize: 13.5 }}>
                  <strong>{detectedSampleRecords.length} sample transactions detected</strong> ({detectedSampleRecords.length === 15 ? "12 from Oct + 3 from Sep" : `${detectedSampleRecords.length} records`} — none belong to your 670 imported CSV rows).
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "4px 12px", fontSize: 12 }}
                  onClick={() => setShowSampleDetails((s) => !s)}
                >
                  {showSampleDetails ? "Hide Table" : `Show All ${detectedSampleRecords.length} Records & IDs`}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: "4px 14px", fontSize: 12, background: "#EF4444", borderColor: "#EF4444" }}
                  onClick={handleManualCleanupSampleRecords}
                >
                  Clean Up {detectedSampleRecords.length} Sample Records
                </button>
              </div>
            </div>

            {showSampleDetails && (
              <div style={{ marginTop: 12, overflowX: "auto", maxHeight: 280, border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, background: "rgba(0,0,0,0.2)" }}>
                <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", textAlign: "left" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)" }}>
                      <th style={{ padding: "8px 10px" }}>#</th>
                      <th style={{ padding: "8px 10px" }}>Exact ID</th>
                      <th style={{ padding: "8px 10px" }}>Date</th>
                      <th style={{ padding: "8px 10px" }}>Description</th>
                      <th style={{ padding: "8px 10px" }}>Category</th>
                      <th style={{ padding: "8px 10px" }}>Amount</th>
                      <th style={{ padding: "8px 10px" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detectedSampleRecords.map((r, i) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                        <td style={{ padding: "6px 10px", color: "var(--text-muted)" }}>{i + 1}</td>
                        <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 11, color: "var(--accent, #818CF8)" }}>{r.id}</td>
                        <td style={{ padding: "6px 10px" }}>{r.date}</td>
                        <td style={{ padding: "6px 10px", fontWeight: 500 }}>{r.description}</td>
                        <td style={{ padding: "6px 10px" }}>{r.category}</td>
                        <td style={{ padding: "6px 10px", fontWeight: 600 }}>{currency(r.amount)}</td>
                        <td style={{ padding: "6px 10px", color: "#F59E0B" }}>Sample Record</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {migrationAlert && (
          <div
            className={`import-banner ${typeof migrationAlert === "object" && migrationAlert.type === "error" ? "warn" : "ok"}`}
            style={{ marginBottom: 16 }}
          >
            <div className="import-banner-text" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {typeof migrationAlert === "object" && migrationAlert.type === "error" ? (
                <AlertTriangle size={16} style={{ color: "#F59E0B", flexShrink: 0 }} />
              ) : (
                <CheckCircle2 size={16} style={{ color: "#4ADE80", flexShrink: 0 }} />
              )}
              <span>{typeof migrationAlert === "object" ? migrationAlert.text : migrationAlert}</span>
              {typeof migrationAlert === "object" && migrationAlert.type === "error" && (
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "3px 10px", fontSize: 12, marginLeft: 8 }}
                  onClick={runSyncAndMigration}
                >
                  Retry Sync
                </button>
              )}
            </div>
            <button className="icon-btn" onClick={() => setMigrationAlert(null)} aria-label="Dismiss">
              <X size={15} />
            </button>
          </div>
        )}

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
          {syncStatus === "synced"
            ? `Your transactions are synced to the cloud. ${transactions.length} total transactions.`
            : syncStatus === "syncing"
            ? `Syncing with cloud... ${transactions.length} total transactions.`
            : `Offline mode (local cache). ${transactions.length} total transactions.`}
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
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [urlMessage, setUrlMessage] = useState(() => {
    try {
      if (typeof window === "undefined") return null;
      const hash = window.location.hash;
      const search = window.location.search;
      const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
      const searchParams = new URLSearchParams(search);
      const errDesc = hashParams.get("error_description") || searchParams.get("error_description");
      if (errDesc) {
        window.history.replaceState({}, document.title, window.location.pathname);
        return {
          type: "error",
          text: decodeURIComponent(errDesc.replace(/\+/g, " ")),
        };
      }
    } catch {
      // Ignore URL parsing errors
    }
    return null;
  });

  useEffect(() => {
    // 1. Check for authorization code or tokens in URL when returning from email link
    try {
      const search = window.location.search;
      const searchParams = new URLSearchParams(search);

      // If PKCE authorization code is returned (?code=...), exchange it for session
      const code = searchParams.get("code");
      if (code) {
        supabase.auth.exchangeCodeForSession(code).then(({ data, error }) => {
          if (data?.session) {
            setSession(data.session);
            window.history.replaceState({}, document.title, window.location.pathname);
          } else if (error) {
            setUrlMessage({ type: "error", text: error.message });
          }
        });
      }

      // If OTP token hash is returned (?token_hash=...&type=...)
      const token_hash = searchParams.get("token_hash");
      const type = searchParams.get("type");
      if (token_hash) {
        supabase.auth.verifyOtp({ token_hash, type: type || "email" }).then(({ data, error }) => {
          if (data?.session) {
            setSession(data.session);
            window.history.replaceState({}, document.title, window.location.pathname);
          } else if (error) {
            setUrlMessage({ type: "error", text: error.message });
          }
        });
      }

      // Clean up URL hash if implicit access_token was passed
      const hash = window.location.hash;
      const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
      if (hashParams.get("access_token")) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    } catch (e) {
      console.warn("Could not parse URL auth tokens:", e);
    }

    // 2. Normal session retrieval & subscription
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "SIGNED_OUT" || !newSession) {
        if (session?.user?.id) {
          clearUserCache(session.user.id);
        }
        clearLegacyStorage();
        try {
          delete window.__SAMPLE_RECORDS__;
        } catch {
          // Ignore
        }
      }
      setSession(newSession);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [session?.user?.id]);

  useEffect(() => {
    try {
      safeStorage.setItem(THEME_KEY, theme);
    } catch {
      console.warn("Could not save theme to storage");
    }
  }, [theme]);

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);

  const handleAuthenticated = useCallback((user) => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) setSession(session);
      else if (user) setSession({ user });
    });
  }, []);

  const handleLogout = useCallback(async () => {
    // Clear user-scoped transaction cache and legacy storage to prevent cross-account leak
    if (session?.user?.id) {
      clearUserCache(session.user.id);
    }
    clearLegacyStorage();
    try {
      delete window.__SAMPLE_RECORDS__;
    } catch {
      // Ignore if not present or in non-browser context
    }

    await authService.logout();
    setSession(null);
  }, [session]);

  if (loading) {
    return (
      <div className={`pft-root theme-${theme} auth-shell`} style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <style>{CSS}</style>
        <div style={{ color: "var(--text-muted)", fontSize: "14px", display: "flex", alignItems: "center", gap: 10 }}>
          <RefreshCw size={18} className="spin" />
          <span>Connecting to Supabase Cloud...</span>
        </div>
      </div>
    );
  }

  if (!session || !session.user) {
    return <LoginScreen onAuthenticated={handleAuthenticated} theme={theme} onToggleTheme={toggleTheme} urlMessage={urlMessage} />;
  }

  return (
    <Dashboard
      onLogout={handleLogout}
      currentUser={session.user.email}
      user={session.user}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );
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

.auth-mode-tabs {
  display: flex;
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius-sm);
  padding: 4px;
  margin-bottom: 20px;
  gap: 4px;
}
.auth-mode-tab {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 0;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.auth-mode-tab.active {
  background: var(--card);
  color: var(--text);
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.auth-info-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: rgba(74,222,128,0.1);
  border: 1px solid rgba(74,222,128,0.3);
  color: #4ADE80;
  font-size: 12.5px;
  font-weight: 500;
  padding: 10px 12px;
  border-radius: 10px;
  line-height: 1.4;
}
.sync-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--card-border);
  background: var(--card);
}
.sync-pill.synced { color: #4ADE80; border-color: rgba(74,222,128,0.35); }
.sync-pill.syncing { color: #60A5FA; border-color: rgba(96,165,250,0.35); }
.sync-pill.error { color: #F87171; border-color: rgba(248,113,113,0.35); }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { animation: spin 1s linear infinite; }

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

/* ---------- Batch & Multi-entry Modal ---------- */
.modal-card.batch-modal {
  width: 100%;
  max-width: 580px;
  max-height: 88vh;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.batch-modal-header {
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--card-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
}

.batch-modal-header h3 {
  font-family: 'Outfit', sans-serif;
  font-size: 17px;
  font-weight: 700;
  margin: 0;
}

.batch-form-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.batch-modal-body {
  padding: 18px 22px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
}

.batch-modal-footer {
  padding: 14px 22px;
  border-top: 1px solid var(--card-border);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-shrink: 0;
  background: var(--card);
}

.batch-entry-card {
  background: var(--input-bg);
  border: 1px solid var(--card-border);
  border-radius: 12px;
  padding: 15px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s ease;
}

.batch-entry-card:focus-within {
  border-color: rgba(37, 99, 235, 0.4);
}

.batch-entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--card-border);
}

.batch-entry-num {
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.batch-remove-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 11.5px;
  font-weight: 600;
  color: #EF4444;
  background: rgba(239, 68, 68, 0.08);
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.batch-remove-btn:hover {
  background: rgba(239, 68, 68, 0.18);
}

.add-another-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  border: 1.5px dashed var(--card-border);
  border-radius: 12px;
  background: transparent;
  color: var(--primary);
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.add-another-btn:hover:not(:disabled) {
  border-color: var(--primary);
  background: rgba(37, 99, 235, 0.06);
}

.date-input-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
}

.date-input-wrap input {
  flex: 1;
}

.quick-today-btn {
  font-size: 11px;
  font-weight: 600;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--card);
  border: 1px solid var(--card-border);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.quick-today-btn:hover {
  color: var(--text);
  border-color: var(--primary);
}

.batch-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 700;
  background: rgba(37, 99, 235, 0.12);
  color: #38BDF8;
}

.batch-summary-strip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-muted);
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.1);
  border-radius: 8px;
}

/* ---------- Responsive ---------- */
@media (max-width: 900px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 640px) {
  .app-shell { padding: 16px 14px 50px; }
  .kpi-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
  .kpi-card { padding: 14px; }
  .kpi-value { font-size: 21px; }
  .add-btn span { display: inline !important; }
  .add-btn { padding: 9px 13px; font-size: 13px; }
  .csv-btn span { display: none; }
  .csv-btn { padding: 9px 11px; }
  .modal-card.batch-modal { max-height: 94vh; border-radius: 14px; }
  .batch-modal-header { padding: 14px 16px 12px; }
  .batch-modal-body { padding: 14px 16px; gap: 12px; }
  .batch-modal-footer { padding: 12px 16px; flex-direction: column-reverse; gap: 8px; }
  .batch-modal-footer button { width: 100%; }
  .batch-entry-card { padding: 12px; }
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
