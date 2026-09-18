// Client transport for the shared-spaces relay (see relay/README.md).
//
// Every call takes a `space` bundle slice: { id, token }. The relay only ever
// sees that id, a hash of that token, and ciphertext — so everything here is
// deliberately dumb: no decryption, no merging, no state.
//
// Errors are normalised the same way sync.js does it, so callers can switch on
// a short string instead of an HTTP status:
//   offline · unauthorised · conflict (err.current = { version, blob })
//   too-large · rate-limit · not-found · http-NNN

import { relayUrl } from "./config.js";

/** Throwable with a stable, switchable `message`. */
function relayError(code, extra) {
  const err = new Error(code);
  if (extra) Object.assign(err, extra);
  return err;
}

function base() {
  const url = relayUrl();
  if (!url) throw relayError("not-configured");
  return String(url).replace(/\/+$/, "");
}

function spaceUrl(space, suffix = "") {
  if (!space || !space.id || !space.token) throw relayError("unauthorised");
  return `${base()}/v1/space/${encodeURIComponent(space.id)}${suffix}`;
}

async function readJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** One place where an HTTP status becomes one of our short codes. */
async function normalise(res) {
  if (res.status === 401 || res.status === 403) throw relayError("unauthorised");
  if (res.status === 404) throw relayError("not-found");
  if (res.status === 412) {
    const body = await readJson(res);
    throw relayError("conflict", {
      current: { version: body?.version ?? null, blob: body?.blob ?? null },
    });
  }
  if (res.status === 413) throw relayError("too-large");
  if (res.status === 429) throw relayError("rate-limit");
  if (res.status === 304) return res; // not an error: caller asked with If-None-Match
  if (!res.ok) throw relayError("http-" + res.status);
  return res;
}

async function call(url, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  let res;
  try {
    res = await fetch(url, { ...init, headers, cache: "no-store" });
  } catch {
    throw relayError("offline");
  }
  return normalise(res);
}

function tokenHeaders(space) {
  return { "X-Space-Token": space.token };
}

function versionOf(res) {
  const tag = res.headers.get("ETag") || res.headers.get("X-Version");
  if (!tag) return null;
  const n = Number(String(tag).replace(/^W\//, "").replace(/"/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Read the space. Pass `knownVersion` to get `{ notModified: true }` back
 * instead of the blob when nothing changed (cheap polling with If-None-Match).
 */
export async function relayGet(space, { knownVersion = null } = {}) {
  const headers = tokenHeaders(space);
  if (knownVersion != null) headers["If-None-Match"] = `"${knownVersion}"`;
  const res = await call(spaceUrl(space), { method: "GET", headers });
  if (res.status === 304) return { notModified: true, version: versionOf(res) ?? knownVersion };
  const body = await readJson(res);
  return {
    notModified: false,
    version: body?.version ?? versionOf(res),
    blob: body?.blob ?? null,
    updatedAt: body?.updatedAt ?? null,
  };
}

/**
 * Write the space. `version` is the version you last saw — 0 to create.
 * The relay stores version + 1 and returns it. A concurrent writer means a
 * `conflict` error carrying the current `{ version, blob }`.
 */
export async function relayPut(space, version, blob) {
  const res = await call(spaceUrl(space), {
    method: "PUT",
    headers: { ...tokenHeaders(space), "If-Match": `"${version}"` },
    body: JSON.stringify({ version, blob }),
  });
  const body = await readJson(res);
  return { version: body?.version ?? versionOf(res), updatedAt: body?.updatedAt ?? null };
}

/** Version only — for the 3-minute poll. */
export async function relayHead(space) {
  const res = await call(spaceUrl(space), { method: "HEAD", headers: tokenHeaders(space) });
  return { version: versionOf(res) };
}

export async function relaySubscribe(space, deviceId, memberId, subscription) {
  const sub = typeof subscription?.toJSON === "function" ? subscription.toJSON() : subscription;
  await call(spaceUrl(space, "/sub/" + encodeURIComponent(deviceId)), {
    method: "PUT",
    headers: tokenHeaders(space),
    body: JSON.stringify({ memberId, subscription: sub }),
  });
  return true;
}

export async function relayUnsubscribe(space, deviceId) {
  await call(spaceUrl(space, "/sub/" + encodeURIComponent(deviceId)), {
    method: "DELETE",
    headers: tokenHeaders(space),
  });
  return true;
}

/**
 * Fan out one opaque notification. `payloadB64` is already encrypted with the
 * space's notification key by the caller; the relay cannot read it.
 */
export async function relayNotify(space, payloadB64, exceptDeviceId = null) {
  const res = await call(spaceUrl(space, "/notify"), {
    method: "POST",
    // X-Space-Id is what the relay wraps the payload with, so the service
    // worker can find the right notification key (relay/README.md).
    headers: { ...tokenHeaders(space), "X-Space-Id": space.id },
    body: JSON.stringify({ payload: payloadB64, exceptDeviceId }),
  });
  const body = await readJson(res);
  return { sent: body?.sent ?? 0, gone: body?.gone ?? 0 };
}

/** Swap the write token so old invites stop working. Data key rotation is local. */
export async function relayRotate(space, newTokenHash) {
  const res = await call(spaceUrl(space, "/rotate"), {
    method: "POST",
    headers: tokenHeaders(space),
    body: JSON.stringify({ newTokenHash }),
  });
  const body = await readJson(res);
  return { version: body?.version ?? null };
}

/** Wipe blob and subscriptions (leave-last, or after a rotate). */
export async function relayDelete(space) {
  await call(spaceUrl(space), { method: "DELETE", headers: tokenHeaders(space) });
  return true;
}
