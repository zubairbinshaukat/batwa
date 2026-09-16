// Pakistani bank / wallet SMS -> a prefill for the add sheets.
// Pure: no DOM, no ledger, no storage. Everything here is a guess the user can
// see and correct — the raw message rides along as the entry's note.
//
// Wording caveat (see docs/plans/daily-helpers.md §6.2): only the Easypaisa
// fragments are verbatim; every other pattern is reconstructed from the shared
// structure [verb] [amount] [counterparty] [fee?] [balance] [ref] [date].

const NUM = String.raw`\d[\d,]*(?:\.\d{1,2})?`;
const CUR = String.raw`(?:PKR|Rs\.?|RS\.?)`;

/** Brand -> regex, keyed by LOGO_KINDS. Specific names before generic ones. */
export const PROVIDER_PATTERNS = {
  jazzcash:   /jazz ?cash/i,
  easypaisa:  /easy ?paisa/i,
  nayapay:    /naya ?pay/i,
  sadapay:    /sada ?pay/i,
  zindigi:    /zindigi/i,
  upaisa:     /u ?paisa/i,
  meezan:     /meezan/i,
  habibmetro: /habib ?metro/i,
  alhabib:    /al ?habib|\bBAHL\b/i,
  hbl:        /\bHBL\b|habib bank/i,
  ubl:        /\bUBL\b|united bank/i,
  alfalah:    /alfalah/i,
  mcb:        /\bMCB\b/i,
  allied:     /allied bank|\bABL\b/i,
  askari:     /askari/i,
  faysal:     /faysal/i,
  nbp:        /\bNBP\b|national bank/i,
  bop:        /bank of punjab|\bBOP\b/i,
  jsbank:     /\bJS ?bank\b/i,
  soneri:     /soneri/i,
  scb:        /standard chartered|\bSCB\b/i,
  dib:        /dubai islamic|\bDIB\b/i,
  bankislami: /bank ?islami/i,
  albaraka:   /al ?baraka/i,
};

/** Merchant keyword -> category. First match wins, so order is the priority. */
const CATEGORY_KEYWORDS = [
  ["Transport", /careem|uber|bykea|indrive|\bPSO\b|shell|total parco|fuel|petrol/i],
  ["Food", /foodpanda|\bKFC\b|mcdonald|pizza|cafe|restaurant|bakery/i],
  ["Bills", /k-?electric|lesco|iesco|fesco|gepco|mepco|hesco|sngpl|ssgc|ptcl|nayatel|stormfiber|\bjazz\b|zong|telenor|ufone|netflix|spotify|youtube/i],
  ["Shopping", /daraz|amazon|aliexpress|\bmall\b|\bstore\b|\bmart\b/i],
  ["Health", /pharmacy|hospital|clinic|\blab\b/i],
  ["Education", /university|college|school|academy|\bfee\b/i],
];

const MONTHS3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Words that can never be part of a counterparty name — they start the next clause.
const STOP_WORDS = new Set([
  "on", "at", "via", "through", "from", "to", "and", "is", "was", "were", "has", "have",
  "had", "been", "be", "the", "your", "you", "my", "with", "by", "of", "in", "for", "a",
  "an", "ref", "reference", "trx", "txn", "tid", "rrn", "stan", "auth", "code", "avl",
  "bal", "balance", "available", "remaining", "current", "cur", "new", "acct", "account",
  "wallet", "card", "dated", "date", "using", "used", "completed", "successful",
  "successfully", "processed", "fee", "fees", "charges", "charge", "tax", "will", "this",
  "that", "it", "no", "number",
]);

const toNum = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return isFinite(n) ? n : null;
};

const pad = (n) => String(n).padStart(2, "0");

/** Provider brand, or null — traditional banks often only identify in the sender ID. */
function findProvider(text) {
  for (const [kind, re] of Object.entries(PROVIDER_PATTERNS)) {
    const m = text.match(re);
    if (m) return { kind, match: m[0] };
  }
  return { kind: null, match: null };
}

/**
 * Words following `to` / `at` / `for` / `from`, until a stop word, a sentence
 * end, or punctuation. Masked numbers and ALLCAPS merchants are kept as-is.
 */
function grabName(text, preps) {
  for (const prep of preps) {
    const re = new RegExp(String.raw`\b${prep}\s+(.{1,80})`, "i");
    const m = text.match(re);
    if (!m) continue;
    const tail = m[1];
    const words = tail.split(/\s+/);
    const out = [];
    for (let w of words) {
      // a full stop that ends a sentence terminates the name; one inside a
      // token (NETFLIX.COM) does not
      const sentenceEnd = /[.,;:!?)]$/.test(w);
      w = w.replace(/[.,;:!?)]+$/, "");
      if (/^[([]/.test(w)) break;
      const bare = w.replace(/[^A-Za-z]/g, "").toLowerCase();
      if (!w) break;
      if (bare && STOP_WORDS.has(bare)) break;
      out.push(w);
      if (sentenceEnd || out.length >= 6) break;
    }
    const name = out.join(" ").trim();
    if (name) return name;
  }
  return null;
}

/**
 * Parse one shared SMS. Never throws; every field is nullable.
 * -> { direction, amount, balance, counterparty, providerKind, date,
 *      categoryGuess, reason, rejected }
 */
export function parseTransactionSms(raw) {
  const out = {
    direction: null, amount: null, balance: null, counterparty: null,
    providerKind: null, date: null, categoryGuess: null, reason: null, rejected: null,
  };
  if (!raw) return out;

  // 1. normalise
  const full = String(raw).slice(0, 2048).replace(/\/-/g, "").replace(/\s+/g, " ").trim();
  if (!full) return out;

  // provider + category read the whole message: wallets name themselves inside
  // spans we are about to blank
  const prov = findProvider(full);
  out.providerKind = prov.kind;

  // 2. reject filters
  if (/\b(reversed|reversal|failed|declined|unsuccessful|could not be)\b/i.test(full)) {
    out.rejected = "reversal";
    return out;
  }
  if (/\bOTP\b|one[- ]time (?:pass|pin)|do not share/i.test(full)) {
    out.rejected = "otp";
    return out;
  }

  let text = full;

  // 3. balance span first — it is an amount too, and always after the real one
  const balRe = new RegExp(String.raw`\b(?:bal|balance)\b\.?\s*(?:is|:|=)?\s*${CUR}?\s*(${NUM})`, "i");
  const balM = text.match(balRe);
  if (balM) {
    out.balance = toNum(balM[1]);
    text = text.replace(balM[0], " ");
  }

  // 4. fee / charges spans — "Fee Rs 0" would otherwise steal the amount
  const feeRe = new RegExp(String.raw`\b(?:fee|fees|charges?|service charges?|tax|FED|WHT)\b[^.]{0,40}?${CUR}\s*${NUM}`, "gi");
  text = text.replace(feeRe, " ");

  // 5. amount
  const amtM = text.match(new RegExp(String.raw`${CUR}\s*(${NUM})`, "i"))
    || text.match(new RegExp(String.raw`(${NUM})\s*(?:PKR|rupees)`, "i"));
  if (amtM) out.amount = toNum(amtM[1]);

  // 6. direction — earliest keyword wins, but an explicit "credited to your
  //    account/wallet" always reads as money coming in
  const CREDIT = /\b(?:credited|credit|received|receive|deposit|deposited|cash[- ]?in|salary|refund(?:ed)?|added to your)\b/i;
  const DEBIT = /\b(?:debited|debit|sent|paid|payment|transferred|transfer|withdrawn|withdrawal|withdraw|purchase|spent|deducted|charged|was used|\bPOS\b|\bATM\b)\b/i;
  const ci = full.search(CREDIT);
  const di = full.search(DEBIT);
  if (/credited to your (?:account|wallet)/i.test(full)) out.direction = "credit";
  else if (ci < 0 && di < 0) { out.rejected = "no-direction"; return out; }
  else if (ci < 0) out.direction = "debit";
  else if (di < 0) out.direction = "credit";
  else out.direction = ci < di ? "credit" : "debit";

  // 7. strip refs before reading names off the text
  text = text.replace(
    /\b(?:TID|Trx\.? ?ID|Txn\.? ?ID|Transaction ID|Ref\.? ?No\.?|Ref#|Ref\.?|RRN|STAN|Auth\.? ?Code)\b\s*[:#]?\s*[A-Za-z0-9]+/gi,
    " "
  );

  // 8. counterparty
  const name = out.direction === "credit"
    ? grabName(text, ["from"])
    : grabName(text, ["to", "at", "for"]);
  if (name) out.counterparty = name.replace(/\s+PK$/i, "").trim() || null;

  // a credit with no sender still usually says what it was
  const reasonM = full.match(/\b(salary|cash deposit|refund|bonus|pension|cash ?in)\b/i);
  if (reasonM) out.reason = reasonM[1].replace(/\b\w/g, (c) => c.toUpperCase());

  // 9. date
  out.date = findDate(full);

  // 10. category — read off the blanked text so a "fee Rs 10" line can't vote,
  //     and never let the brand name itself decide ("jazz" is a telco too)
  const catText = prov.match ? text.split(prov.match).join(" ") : text;
  for (const [cat, re] of CATEGORY_KEYWORDS) {
    if (re.test(catText)) { out.categoryGuess = cat; break; }
  }

  return out;
}

function findDate(text) {
  let m = text.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})\b/);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  m = text.match(/\b(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4}|\d{2})\b/);
  if (m) {
    const d = +m[1];
    const mo = MONTHS3.indexOf(m[2].toLowerCase()) + 1;
    let y = +m[3];
    if (m[3].length === 2) y += 2000;
    if (mo && d >= 1 && d <= 31) return `${y}-${pad(mo)}-${pad(d)}`;
  }
  return null;
}

/**
 * Which account the message belongs to.
 *   one account in total     -> that one
 *   one account of the brand -> that one
 *   several                  -> remembered choice for that brand, else unset
 * Returns an accountId or null; null means "leave the picker alone".
 */
export function matchAccount(parsed, accounts = [], memory = {}) {
  if (!accounts.length) return null;
  if (accounts.length === 1) return accounts[0].id;
  const kind = parsed?.providerKind;
  if (!kind) return null;
  const same = accounts.filter((a) => a.kind === kind);
  if (same.length === 1) return same[0].id;
  if (same.length > 1) {
    const remembered = memory && memory[kind];
    if (remembered && same.some((a) => a.id === remembered)) return remembered;
  }
  return null;
}

/** Title for a prefill, given the parse and the brand's display name. */
export function prefillTitle(parsed, providerName) {
  if (parsed.counterparty) return parsed.counterparty;
  if (parsed.reason) return parsed.reason;
  if (providerName) return `${providerName} ${parsed.direction === "credit" ? "transfer in" : "payment"}`;
  return parsed.direction === "credit" ? "Money received" : "Card purchase";
}
