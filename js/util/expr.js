// Quick math for the amount field: "120+80", "1,500/3", "(300+200)*2".
// Hand-rolled tokeniser + recursive descent over + - * / ( ). Never eval/Function —
// this runs on whatever the user (or a shared SMS) typed.

const MAX_LEN = 64;

/** Normalise unicode operators and strip thousands separators / spaces. */
function normalise(str) {
  return String(str)
    .replace(/[×✕✖]/g, "*")
    .replace(/[÷∕]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/[,\s]/g, "");
}

/** true when the raw text looks like an expression rather than a plain number. */
export function looksLikeExpr(raw) {
  return /[+\-*/()×÷−]/.test(String(raw || "").trim().replace(/^-/, ""));
}

function tokenise(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if ("+-*/()".includes(c)) { out.push(c); i++; continue; }
    if (c >= "0" && c <= "9") {
      let j = i;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      const lit = s.slice(i, j);
      if ((lit.match(/\./g) || []).length > 1) return null;
      const n = Number(lit);
      if (!isFinite(n)) return null;
      out.push(n);
      i = j;
      continue;
    }
    if (c === ".") { // ".5" is fine, ".." is not
      let j = i;
      while (j < s.length && ((s[j] >= "0" && s[j] <= "9") || s[j] === ".")) j++;
      const lit = s.slice(i, j);
      if ((lit.match(/\./g) || []).length > 1 || lit === ".") return null;
      out.push(Number(lit));
      i = j;
      continue;
    }
    return null; // anything else is not ours
  }
  return out;
}

/**
 * Evaluate an amount expression. Returns a number > 0 rounded to 2 dp, or null
 * for anything malformed, negative, zero, or divided by zero.
 */
export function evalAmountExpr(raw) {
  const src = normalise(raw);
  if (!src || src.length > MAX_LEN) return null;
  const t = tokenise(src);
  if (!t || !t.length) return null;

  let p = 0;
  const peek = () => t[p];
  const eat = (x) => (t[p] === x ? (p++, true) : false);
  let bad = false;

  function primary() {
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) { bad = true; return 0; }
      return v;
    }
    if (eat("-")) return -primary();   // unary minus
    if (eat("+")) return primary();
    const v = peek();
    if (typeof v !== "number") { bad = true; return 0; }
    p++;
    return v;
  }

  function term() {
    let v = primary();
    while (!bad && (peek() === "*" || peek() === "/")) {
      const op = t[p++];
      const r = primary();
      if (bad) return 0;
      if (op === "/") {
        if (r === 0) { bad = true; return 0; }
        v /= r;
      } else v *= r;
    }
    return v;
  }

  function expr() {
    let v = term();
    while (!bad && (peek() === "+" || peek() === "-")) {
      const op = t[p++];
      const r = term();
      if (bad) return 0;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  const value = expr();
  if (bad || p !== t.length) return null;
  if (!isFinite(value) || value <= 0) return null;
  return Math.round(value * 100) / 100;
}
