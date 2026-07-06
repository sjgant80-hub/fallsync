# FallSync

**CRDT multi-device sync for the browser. No cloud.**

FallSync solves keeping state in sync across a laptop, phone, and tablet without a server in the middle. Any two devices exchange state and merge deterministically — the same inputs give the same outputs, in any order, on any device.

Live demo: [sjgant80-hub.github.io/fallsync](https://sjgant80-hub.github.io/fallsync/)

## What it does

- Keeps a keyed map (like `Map<string, any>`) in sync across N devices
- Merges any two states deterministically — no coordinator, no "primary"
- Handles concurrent writes on the same key with **Last-Writer-Wins** semantics: highest Lamport timestamp wins; ties broken by nodeId lex order
- Supports deletes as tombstones
- Takes snapshots to a content-addressed CID (via FallStore, or localStorage fallback)
- Wires to [FallLink](https://sjgant80-hub.github.io/falllink/) for peer transport (data channels, no server)

## What it is

A tiny ES module — one file, no dependencies. Bring your own transport (FallLink recommended) and your own storage (FallStore recommended).

## Install

```html
<script type="module">
  import { FallSync } from 'https://sjgant80-hub.github.io/fallsync/fallsync.js';
</script>
```

Or copy `fallsync.js` into your project.

## Quick start

```js
import { FallSync } from './fallsync.js';

const sync = new FallSync({
  nodeId: 'my-laptop-uuid',  // per-device identifier (Ed25519 pubkey or UUID)
  docId: 'my-bloom-journal'  // which doc this instance syncs
});

await sync.set('name', 'Simon');
await sync.set('mood', 7);
sync.get('name');    // 'Simon'
sync.delete('mood'); // tombstone

// Full CRDT state — JSON-safe
const state = sync.getState();

// Merge another peer's state
const changedKeys = sync.merge(otherState);

// Subscribe to changes
sync.subscribe(evt => console.log(evt.type, evt.key));
```

## Wire to FallLink

```js
import { FallLink } from 'https://sjgant80-hub.github.io/falllink/falllink.js';

const link = new FallLink({ /* ... */ });
sync.attachLink(link);
// Now every `set` / `delete` broadcasts to peers, and remote ops merge in.
```

## Snapshot to FallStore

```js
import { FallStore } from 'https://sjgant80-hub.github.io/fallstore/fallstore.js';

sync.attachStore(new FallStore());
const cid = await sync.snapshot();          // content-addressed
await sync.loadSnapshot(cid);               // restore
```

Without FallStore, snapshots fall back to `localStorage` under a `sha256-...` key.

## CRDT design

FallSync implements a **LWW-Map with Lamport timestamps**:

- Every entry stores `{ value, ts, nodeId, hash, deleted }`
- `ts` is a Lamport clock: increments on every local op, and jumps forward on merge to `max(local, remote) + 1`
- Merge rule: for each key, compare `(ts, nodeId)` lexicographically. Higher `ts` wins; on tie, lex-higher `nodeId` wins.
- Deletes are tombstones (an entry with `deleted: true` and a timestamp)

This gives **strong eventual consistency**: any two replicas that have received the same set of ops converge to the same state, regardless of order.

Ties are impossible to fully avoid in a distributed system, but the tie-break rule is deterministic — every device picks the same winner.

## API

| Method | Returns | What it does |
|---|---|---|
| `new FallSync({ nodeId, docId })` | instance | Creates a new replica |
| `set(key, value)` | entry | Writes an LWW entry |
| `get(key)` | value \| undefined | Reads current value |
| `has(key)` | boolean | True if key is present and not tombstoned |
| `delete(key)` | entry | Writes a tombstone |
| `keys()` | string[] | Live keys (excluding tombstones) |
| `getState()` | object | Full CRDT state (for snapshot/wire) |
| `loadState(state)` | void | Replaces state authoritatively |
| `merge(otherState)` | string[] | Merges; returns changed keys |
| `diff(otherState)` | `{local, remote, equal, keys}` | Per-key comparison |
| `subscribe(fn)` | unsubscribe fn | Listen for local + remote events |
| `attachLink(link)` | void | Wire to a FallLink peer transport |
| `attachStore(store)` | void | Wire to a FallStore content-addressed store |
| `snapshot()` | CID string | Stores full state, returns content ID |
| `loadSnapshot(cid)` | state | Restores state from CID |
| `export()` | JSON string | Serialize |
| `import(json)` | void | Deserialize |

## Events

`subscribe(fn)` receives events with `type`:

- `set` — local set
- `delete` — local delete
- `merge` — states merged (local pulled in remote wins)
- `remote` — single remote op received over link
- `remote-merge` — full state received over link
- `snapshot` — snapshot written (has `cid`)
- `loaded-snapshot` — snapshot restored (has `cid`)
- `load` — state replaced (has `state`)

## Uses across the estate

FallSync is the sync spine for:

- **FallBloom** — mood/journal state across your devices
- **FallMirror** — reflection sessions
- **FallSignal** — signature history
- **FallHub** — operator state across POS + phone + laptop
- Any FallStack app that needs multi-device state without a server

## License

MIT · AI-Native Solutions · 2026

## The stack

- [FallLink](https://sjgant80-hub.github.io/falllink/) — peer-to-peer transport
- [FallStore](https://sjgant80-hub.github.io/fallstore/) — content-addressed blobs
- **FallSync** — CRDT sync layer
- [FallColony](https://sjgant80-hub.github.io/fallcolony/) — the settlement
