# Arkiv schema

We keep four kinds of entity on Arkiv's Rabdi testnet (chain ID 7794095).
Our web server's wallet writes all of them.

Writer wallet: `0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB`. It wrote the rows below.

All kinds are written with expiry `fromDays(30)`, flags `{readonly: true, permissionlessExtension: false}` and an indexed `arkiv.schema` tag.
All four are defined in `web/src/lib/arkiv.ts`.

## Entity 1: authorisation record

One record says: one person approved this seal's hash through World. World proves a unique human approved this exact photo; the session says which username.
A person passes World once for the name, and again for every photo. A photo with no session has no username.
Schema tag: `blank-demo.seals`. Code: `Seals` in `web/src/lib/arkiv.ts`.

| Field | Type | Indexed? | What it holds |
| --- | --- | --- | --- |
| `hash` | `str` | yes | The seal's hash, 64 lowercase hex characters. |
| `pass` | `str` | yes | With a session from the name step: the person's join pass, so their photos group together. Without one: this proof's own number. Such a photo counts as unnamed, not as a person. |
| `event` | `str`, optional | yes | The event's short name, at most 40 characters. |
| `at` | `u64` | yes | The time it was filed, in Unix milliseconds. |
| `credential` | `str` | no | The kind of check: `human` or `selfie`. |
| `name` | `str`, optional | no | The person's user name, when their pass holds one. At most 128 bytes. |
| `account` | `str` | no | No longer filled. It is written empty. |

## Entity 2: picture pointer

One pointer says: the picture for this seal is at this Swarm reference.
Schema tag: `blank-demo.pictures`. Code: `Pictures` in `web/src/lib/arkiv.ts`.

| Field | Type | Indexed? | What it holds |
| --- | --- | --- | --- |
| `hash` | `str` | yes | The seal's hash, 64 hex characters. |
| `event` | `str`, optional | yes | The event's short name. |
| `at` | `u64` | yes | The time it was written, in Unix milliseconds. |
| `ref` | `str` | no | The Swarm reference, 64 hex characters. |
| `sha256` | `str` | no | The picture's hash, 64 hex characters. |
| `size` | `u64` | no | The file size in bytes. |

The file size is called `size`, because Arkiv reserves the word `bytes`.

## Entity 3: user

One user row says: this person, with this pass, has this name.
Schema tag: `blank-demo.users`. Code: `Users` in `web/src/lib/arkiv.ts`.

| Field | Type | Indexed? | What it holds |
| --- | --- | --- | --- |
| `label` | `str` | yes | The name the person chose, in ENS-normalised form. At most 63 bytes. Not reserved (`users`, `events`, `www`, `admin`), not a wallet address or a long hex string, not already taken. |
| `pass` | `str` | yes | The number from the person's join proof. |
| `at` | `u64` | yes | The time it was written, in Unix milliseconds. |
| `name` | `str` | no | The full ENS name. |
| `address` | `str`, optional | no | The address that holds the person's names. Our server holds its key. |

## Entity 4: image name

One row says: this seal's image has this ENS name, made in this transaction.
Schema tag: `blank-demo.names`. Code: `Names` in `web/src/lib/arkiv.ts`.

| Field | Type | Indexed? | What it holds |
| --- | --- | --- | --- |
| `hash` | `str` | yes | The seal's hash, 64 hex characters. |
| `event` | `str` | yes | The event's short name. |
| `at` | `u64` | yes | The time it was written, in Unix milliseconds. |
| `name` | `str` | no | The image's full ENS name. |
| `tx` | `str` | no | The transaction that made the name, on the chain that holds the ENS tree. Empty if the name was on that chain already. |

## Who owns them, and who can change them

- The server's wallet creates and owns every entity of ours.
- Every entity is written read-only. Nobody can change its fields, that wallet included.
- That wallet can still delete an entity, extend its life, or hand it to another wallet.
- Anyone can write an entity with our tag, and hand it to our wallet. So every read filters on the wallet that created it, `$creator` (`seals`, `pictures`, `users` and `names` in `ArkivStore`), then keeps only rows whose `$creationFlags.readonly` is true (`trusted`). The node cannot filter on that flag, so our code checks it.
- When a seal has more than one row, the first is the earliest `$createdAt`, the creation block, which the writer cannot choose, then `$key` (`byCreation`).

## When they expire

- Each entity lives for 30 days. That is 1,296,000 blocks at 2 seconds per block.
- A user row lives 30 days from the person's join. So it can end before that person's later photos end. Its label then looks free on Arkiv (`holdingUsers`). The name step also asks ENS, so a name still on chain stays taken. On the event page, those photos then count as unnamed. The gallery page still shows the name kept on each photo's own record.
- How long the picture stays on Swarm is not promised, so a pointer can outlive its picture. See `swarm.md`.
- Expiry only stops queries from finding an entity. The transaction can stay in the chain's history.
- Rabdi is a testnet, so we do not treat this data as permanent.

## Everything here is public

Hashes, pass numbers, names, addresses and references can be read by anyone.
Never put a secret in an entity.

## The queries we run

Every read uses the wallet filter above.

| Screen or route | Filter | Sort |
| --- | --- | --- |
| One seal, `/api/seal/<hash>` | `hash` | `$key`, then the earliest created is kept |
| One person's seals, `/api/pass/<pass>` | `pass` | `at`, newest first |
| The event page, `/event/<slug>`, `/api/event/<slug>` | `event`, on seals, pointers and names. It also reads the user rows once, for the names | `at`, oldest first |
| One user, `/api/user/<label>` | No field filter: it reads every user row, up to 1,000, and finds the label in our code (`holding` and `userByLabel` in `ArkivStore`) | `at`, oldest first |
| The gallery page, in the browser with no server | `arkiv.schema` and `$creator`, once per kind (`kindQuery` in `gallery/index.html`) | `at`, oldest first |

So six of our indexes serve no filter: `at` on all four kinds, and `label` and `pass` on the user kind.
Arkiv's docs say an index costs extra on every write, and that sorting needs no index. The extra cost: not measured.

## The demo rows

These are the rows of the event `ethglobal`. We read these rows on 07.11.2026.

- Query: `event = str('ethglobal') AND $creator = addr(0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB)` gives 6 read-only rows: 2 seals, 2 pictures and 2 names.
- Seal record: https://rabdi.explorer.arkiv.network/entity/0xf25af966488981a92dbc8d6c37278744b666f03b86c7a39dbad25bff0b42f417
- Picture pointer: https://rabdi.explorer.arkiv.network/entity/0x12cdd771ac68338e0275d51cc26a3bac1b01b870364ae0fedf3e7f488eec295e. Its `ref` is `b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e`.
- ENS on mainnet says the same reference for `image1.ethglobal.events.zk-seal.eth`. We read that on 07.11.2026.

## Earlier test rows

These are real writes on Rabdi, from our tests. They came from staging World proofs from the simulator and generated pictures.

| Kind | Entity | Transaction |
| --- | --- | --- |
| `blank-demo.seals` | `0x6a8bb67138a6578b57752251f2ce80ed6fda5975ddd69836fab04395329c2b19` | `0xbb3b7d48592f2366a8e339434e0945d90eb24d26934b479ef44868afd79166e1` |
| `blank-demo.pictures` | `0xfbe9f25e53427482e4441239a1fe3bd8a080df75f5fcd5302dcbff24bef5d70a` | `0x152bc4c342fcd041363420175debf9ecc6a809d5940c5f70137fee1c3ea38d20` |
| `blank-demo.users` | `0xe17fa4d462c228fa5baccc50d7173bf758f9c9ea5d1cc93819105ce19e113fe0` | `0x1706c06389d651f56cdc1eca86dbb854c0283e2f60fa8a40a08bc70afbdf97fd` |
| `blank-demo.names` | `0x4756baefa6d0041231499a17fbd6c2109a60222a53185220c22d2701ca7b0318` | `0xc623d2e5356517f9864e1e3e774021b89042e99118a42f9716b47c0599bef2c4` |

We read all of this from the chain on 07.11.2026, before the demo rows:

- Our wallet had 10 rows: 4 seals, 4 pictures, 1 user, 1 name.
- `test-run-a` holds 3 seals and 3 pictures. `test-run-b` holds 1 seal, 1 picture and 1 name. Its user row has the label `test-run-b` and no event field. No other event had a row from our wallet then.
- For the four rows above: status 1, gas limit 1,000,000, creator and owner our wallet, read-only true, expiry 1,296,000 blocks (30 days at 2 s).
- Gas used: 205,171 (record), 185,531 (pointer), 181,930 (user), 178,992 (name).
- The image name row's own `tx` field holds `0x56861eabf4698b3203eb5fcadc391a0a7b1240d6b3e075366734d83265f75bf5`. That is a transaction on a local fork of mainnet, where the `test-run-b` chain side ran. We looked for it on mainnet and did not find it.
- Explorer: `https://rabdi.explorer.arkiv.network/entity/<key>`, `/tx/<hash>`, `/address/<wallet>`.
- Record: https://rabdi.explorer.arkiv.network/entity/0x6a8bb67138a6578b57752251f2ce80ed6fda5975ddd69836fab04395329c2b19
- Pointer: https://rabdi.explorer.arkiv.network/entity/0xfbe9f25e53427482e4441239a1fe3bd8a080df75f5fcd5302dcbff24bef5d70a
- User: https://rabdi.explorer.arkiv.network/entity/0xe17fa4d462c228fa5baccc50d7173bf758f9c9ea5d1cc93819105ce19e113fe0
- Image name: https://rabdi.explorer.arkiv.network/entity/0x4756baefa6d0041231499a17fbd6c2109a60222a53185220c22d2701ca7b0318
- Wallet: https://rabdi.explorer.arkiv.network/address/0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB

## One query you can run

It needs no key, but reads with no key share a small budget. When it runs out, Arkiv answers 429 with `ANON_COST_LIMITED`, and `Retry-After` says how long to wait. We saw `limit=10000` and 402 s.

```bash
curl https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H "content-type: application/json" \
  --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
 "event = str('ethglobal') AND $creator = addr(0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB)",
 {"select":{"key":true,"creator":true,"expiresAt":true,"creationFlags":true,"attributes":true},"limit":"0xa"}]}
EOF
```

You should see 6 rows: 2 seals, 2 pictures and 2 names. Each row shows `creator`, and `creationFlags` with `readonly` true. We read these rows on 07.11.2026.
To see every row from our wallet, drop the `event` part.
Explorer: https://rabdi.explorer.arkiv.network/entity-explorer
