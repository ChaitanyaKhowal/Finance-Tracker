export const STORAGE_KEY = "pft_transactions_v1";
export const THEME_KEY = "pft_theme_v1";

const memoryStore = {};

export const safeStorage = (() => {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      const testKey = "__pft_test__";
      window.localStorage.setItem(testKey, "1");
      window.localStorage.removeItem(testKey);
      return window.localStorage;
    }
  } catch {
    // Fall back to memory store below
  }
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(memoryStore, k) ? memoryStore[k] : null),
    setItem: (k, v) => {
      memoryStore[k] = String(v);
    },
    removeItem: (k) => {
      delete memoryStore[k];
    },
    clear: () => {
      Object.keys(memoryStore).forEach((k) => delete memoryStore[k]);
    },
  };
})();

export function getUserCacheKey(userId) {
  return userId ? `pft_transactions_cache_${userId}` : null;
}

export function loadUserTransactions(userId, normalizeFn = (t) => t) {
  if (!userId) return [];
  try {
    const key = getUserCacheKey(userId);
    const raw = safeStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeFn);
      }
    }
  } catch (e) {
    console.error("Failed to load user transactions from storage:", e);
  }
  return [];
}

export function saveUserTransactions(userId, txns) {
  if (!userId || !Array.isArray(txns)) return;
  try {
    const key = getUserCacheKey(userId);
    safeStorage.setItem(key, JSON.stringify(txns));
  } catch (e) {
    console.error("Failed to save user transactions to storage:", e);
  }
}

export function clearUserCache(userId) {
  if (userId) {
    try {
      safeStorage.removeItem(getUserCacheKey(userId));
    } catch (e) {
      console.error("Failed to clear user cache:", e);
    }
  }
}

export function clearLegacyStorage() {
  try {
    safeStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error("Failed to clear legacy storage:", e);
  }
}
