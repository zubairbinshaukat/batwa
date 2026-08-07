// IndexedDB wrapper — hand-rolled, promise-based, two stores.
// `entries` holds ONE encrypted blob (key "blob"). `meta` is key/value.

const DB_NAME = "batwa";
const DB_VERSION = 1;
export const SCHEMA_VERSION = 1;

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      // Migration path: switch on e.oldVersion as the schema grows.
      if (e.oldVersion < 1) {
        db.createObjectStore("entries");
        db.createObjectStore("meta");
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      _db.onversionchange = () => _db.close();
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const req = fn(s);
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const dbGet = (store, key) => tx(store, "readonly", (s) => s.get(key));
export const dbPut = (store, key, val) => tx(store, "readwrite", (s) => s.put(val, key));
export const dbDel = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

// ---- meta convenience ----
export const getMeta = (key) => dbGet("meta", key);
export const setMeta = (key, val) => dbPut("meta", key, val);

/** Ensure schema version marker exists; future migrations hook in here. */
export async function ensureSchema() {
  const v = await getMeta("schemaVersion");
  if (!v) await setMeta("schemaVersion", SCHEMA_VERSION);
  // else if (v < SCHEMA_VERSION) { ...migrate data...; await setMeta("schemaVersion", SCHEMA_VERSION); }
}
