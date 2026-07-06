// FallSync · CRDT multi-device sync library
// LWW-map + Lamport timestamps + FallLink transport · MIT · AI-Native Solutions
// ES module. No cloud. Any two devices merge deterministically.

const enc = new TextEncoder();

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// LWW compare: higher timestamp wins; tie-break by nodeId lex order (higher wins).
function entryWins(a, b) {
  if (!b) return true;
  if (!a) return false;
  if (a.ts !== b.ts) return a.ts > b.ts;
  return a.nodeId > b.nodeId;
}

export class FallSync {
  constructor({ nodeId, docId } = {}) {
    if (!nodeId) throw new Error('FallSync: nodeId required');
    if (!docId) throw new Error('FallSync: docId required');
    this.nodeId = String(nodeId);
    this.docId = String(docId);
    this.lamport = 0;             // Lamport clock
    this.entries = new Map();     // key -> { value, ts, nodeId, hash, deleted }
    this._subs = new Set();
    this._link = null;
    this._store = null;           // FallStore instance if provided
    this._peers = new Set();      // known peer ids we've synced with
  }

  _tick(remoteTs) {
    this.lamport = Math.max(this.lamport, remoteTs || 0) + 1;
    return this.lamport;
  }

  async set(key, value) {
    const ts = this._tick();
    const hash = await sha256hex(stableStringify({ k: key, v: value }));
    const entry = { value, ts, nodeId: this.nodeId, hash, deleted: false };
    this.entries.set(key, entry);
    this._emit({ type: 'set', key, entry });
    this._broadcast({ type: 'op', docId: this.docId, key, entry });
    return entry;
  }

  get(key) {
    const e = this.entries.get(key);
    if (!e || e.deleted) return undefined;
    return e.value;
  }

  has(key) {
    const e = this.entries.get(key);
    return !!(e && !e.deleted);
  }

  async delete(key) {
    const ts = this._tick();
    const hash = await sha256hex(stableStringify({ k: key, tombstone: ts }));
    const entry = { value: null, ts, nodeId: this.nodeId, hash, deleted: true };
    this.entries.set(key, entry);
    this._emit({ type: 'delete', key, entry });
    this._broadcast({ type: 'op', docId: this.docId, key, entry });
    return entry;
  }

  keys() {
    const out = [];
    for (const [k, e] of this.entries) if (!e.deleted) out.push(k);
    return out;
  }

  entriesAll() {
    return Array.from(this.entries.entries()).map(([k, e]) => ({ key: k, ...e }));
  }

  // Full CRDT state — a plain object, cloneable, JSON-safe.
  getState() {
    const state = { docId: this.docId, lamport: this.lamport, entries: {} };
    for (const [k, e] of this.entries) state.entries[k] = { ...e };
    return state;
  }

  // Load a serialized state as authoritative (replaces current). Use for snapshot restore.
  loadState(state) {
    if (!state || state.docId !== this.docId) throw new Error('FallSync: docId mismatch');
    this.lamport = state.lamport || 0;
    this.entries = new Map();
    for (const k of Object.keys(state.entries || {})) this.entries.set(k, { ...state.entries[k] });
    this._emit({ type: 'load', state });
  }

  // Merge another peer's state. Returns array of changed keys.
  merge(otherState) {
    if (!otherState || otherState.docId !== this.docId) return [];
    const changed = [];
    this.lamport = Math.max(this.lamport, otherState.lamport || 0);
    const otherEntries = otherState.entries || {};
    for (const key of Object.keys(otherEntries)) {
      const remote = otherEntries[key];
      const local = this.entries.get(key);
      if (entryWins(remote, local)) {
        this.entries.set(key, { ...remote });
        changed.push(key);
      }
    }
    if (changed.length) this._emit({ type: 'merge', changed });
    return changed;
  }

  // Diff vs another peer's state. Returns { local:[...], remote:[...], equal:[...] }
  diff(otherState) {
    const out = { local: [], remote: [], equal: [], keys: {} };
    if (!otherState || otherState.docId !== this.docId) return out;
    const otherEntries = otherState.entries || {};
    const allKeys = new Set([...this.entries.keys(), ...Object.keys(otherEntries)]);
    for (const key of allKeys) {
      const local = this.entries.get(key);
      const remote = otherEntries[key];
      if (local && !remote) { out.local.push(key); out.keys[key] = 'local'; }
      else if (!local && remote) { out.remote.push(key); out.keys[key] = 'remote'; }
      else if (local && remote) {
        if (local.hash === remote.hash) { out.equal.push(key); out.keys[key] = 'equal'; }
        else if (entryWins(local, remote)) { out.local.push(key); out.keys[key] = 'local'; }
        else { out.remote.push(key); out.keys[key] = 'remote'; }
      }
    }
    return out;
  }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  _emit(evt) {
    for (const fn of this._subs) { try { fn(evt); } catch (e) { console.warn('FallSync sub error', e); } }
  }

  // FallLink wiring. Expects a peer-transport instance with .send(msg) and .on('message', fn) or onmessage.
  attachLink(link) {
    this._link = link;
    if (!link) return;
    const handle = (raw) => {
      let msg = raw;
      if (typeof raw === 'string') { try { msg = JSON.parse(raw); } catch { return; } }
      if (!msg || msg.docId !== this.docId) return;
      if (msg.type === 'op' && msg.key && msg.entry) {
        const remote = msg.entry;
        const local = this.entries.get(msg.key);
        this.lamport = Math.max(this.lamport, remote.ts || 0);
        if (entryWins(remote, local)) {
          this.entries.set(msg.key, { ...remote });
          this._emit({ type: 'remote', key: msg.key, entry: remote });
        }
      } else if (msg.type === 'state' && msg.state) {
        const changed = this.merge(msg.state);
        if (changed.length) this._emit({ type: 'remote-merge', changed });
      } else if (msg.type === 'request-state') {
        this._send({ type: 'state', docId: this.docId, state: this.getState() });
      }
    };
    if (typeof link.on === 'function') link.on('message', handle);
    else if ('onmessage' in link) link.onmessage = (e) => handle(e && e.data !== undefined ? e.data : e);
    // Kick off a state sync request on attach.
    this._send({ type: 'request-state', docId: this.docId });
  }

  _send(msg) {
    if (!this._link) return;
    const payload = JSON.stringify(msg);
    try {
      if (typeof this._link.send === 'function') this._link.send(payload);
      else if (typeof this._link.broadcast === 'function') this._link.broadcast(payload);
    } catch (e) { /* swallow */ }
  }

  _broadcast(msg) { this._send(msg); }

  // Attach a FallStore instance for snapshot/restore.
  attachStore(store) { this._store = store; }

  // Snapshot current state to FallStore, returns CID (or local pseudo-CID if no store).
  async snapshot() {
    const state = this.getState();
    const blob = stableStringify(state);
    if (this._store && typeof this._store.put === 'function') {
      const cid = await this._store.put(blob);
      this._emit({ type: 'snapshot', cid });
      return cid;
    }
    // Fallback: content-addressed local CID via sha256.
    const cid = 'sha256-' + (await sha256hex(blob));
    if (typeof localStorage !== 'undefined') localStorage.setItem('fallsync:snap:' + cid, blob);
    this._emit({ type: 'snapshot', cid, local: true });
    return cid;
  }

  async loadSnapshot(cid) {
    let blob = null;
    if (this._store && typeof this._store.get === 'function') {
      try { blob = await this._store.get(cid); } catch { blob = null; }
    }
    if (!blob && typeof localStorage !== 'undefined') blob = localStorage.getItem('fallsync:snap:' + cid);
    if (!blob) throw new Error('FallSync: snapshot not found: ' + cid);
    const state = JSON.parse(blob);
    this.loadState(state);
    this._emit({ type: 'loaded-snapshot', cid });
    return state;
  }

  // Convenience: export + import as JSON string.
  export() { return stableStringify(this.getState()); }
  import(json) { this.loadState(JSON.parse(json)); }
}

// Stand-alone helpers (also exported for advanced use).
export { entryWins, sha256hex, stableStringify };

// Default export
export default FallSync;
