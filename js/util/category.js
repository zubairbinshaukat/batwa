// Pure category-name helpers.
//
// They live here rather than in ledger.js so a plain `node` fixture can import
// them: ledger.js pulls in db.js (IndexedDB) and, through auth.js, util/dom.js
// (matchMedia) — neither of which exists outside a browser.

/** The fallback category. Always present, never renamed, never deleted. */
export const RESERVED_CATEGORY = "Others";

/** Longest category name we store — matches the input's maxlength. */
export const CATEGORY_MAX = 24;

/** Trim, collapse runs of whitespace, cap at CATEGORY_MAX. Always a string. */
export function normalizeCategoryName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, CATEGORY_MAX)
    .trim(); // the cap can land mid-gap and leave a trailing space
}

/** The stored category matching `name` case-insensitively, or null. Stored casing wins. */
export function findCategoryIn(list, name) {
  const key = String(name ?? "").toLowerCase();
  if (!key) return null;
  return (list || []).find((c) => String(c).toLowerCase() === key) || null;
}

/** Is this name the reserved one, whatever its casing? */
export function isReservedName(name) {
  return String(name ?? "").toLowerCase() === RESERVED_CATEGORY.toLowerCase();
}
