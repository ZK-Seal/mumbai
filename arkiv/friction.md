# Arkiv feedback

Only what really happened to us. Part 1 comes from real writes. These are test rows; no demo event has rows yet.

## Context

- Date and code: 07.11.2026, repo `main` at 0fa234f.
- Versions: `@arkiv-network/sdk` 1.0.1 and `viem` 2.57.16, from `web/package-lock.json`. Node version: not read.
- Network: Rabdi testnet, chain ID 7794095.
- What we used: the SDK, the docs, the public RPC, the explorer, the faucet, and this event's MCP guide and skills.
- What we did not use: an access key. The MCP's `network_status` says an application needs one (`requiredForApplication: true`). We went without it, and part 11 gives the cost.

## 1. What broke on the real write

Nothing broke. A real World proof went to a record on Rabdi, a picture on Swarm and a pointer on Rabdi, and read back through our routes after a restart, with the file store empty. No bug found in `arkiv.ts`.
A later run wrote all four kinds under `test-run-b`: user, seal, picture, name. After a restart, all four read back from Arkiv.

Measured:
- Gas used, from the receipts. Under `test-run-a`: records 205,171, 192,375 and 192,375; pointers 185,531, 183,527 and 183,527. Under `test-run-b`: user 181,930, name 178,992. Gas limit 1,000,000. Before the writes, estimate calls gave 214k and 206k.
- Cost: 6 writes for 0.001142506 tGLM. That is 1,142,506 gas at 1 gwei.
- Time, rounded, with a World proof for each photo: `verify` 7.5 s with the Arkiv write and read-back; a picture upload 11 to 14 s (mostly Swarm); reads 0.3 to 0.9 s.
- Time until the write was in a block: not measured.
- Reads needed before the query found the row: not measured.

What the writes showed:
- Status 1.
- Creator and owner our wallet, read-only true, expiry 1,296,000 blocks (30 days at 2 s).
- No duplicates: a repeated verify and a repeated upload send nothing.
- Three photos with one pass showed as 3 photos, 1 person in that run. The code has changed since. It now counts only people with a name, and those three rows have no name, so today they count as unnamed. We did not run this again.
- The fake-row check ran once at the chain, see part 2. Not run: the same check against the event page and our routes.

## 2. The docs say an owner filter is enough, but it is not

- **Where:** the "Filter results" page says that filtering by owner or creator is the only way to be sure an entity came from an account you trust. Its example uses `ownedBy`.
- **What we did:** we first wrote `ownedBy` from that page. Every read now filters on `$creator` instead.
- **The problem:** Arkiv's own skills say a transfer needs no consent from the one who receives it. So anyone can write a fake record and hand it to our wallet. It then passes `ownedBy`.
- **What we expected:** the docs to say use `createdBy` when you must trust the data.
- **How to reproduce:** from a second funded wallet, write a row with our tags and hand it to our wallet. We did this once. By the row's hash, a filter on our wallet as owner found 1 row, and a filter on our wallet as creator found 0. Row: `0x0fd583b70b914ffed40354351f0984742cb9b04e083c5d9f2aa075e62e50f4c3`, event `test-fake-row`.

## 3. The docs and the guide disagree about gas

- The "Create entities" page says anything you leave out is estimated.
- The event guide says Rabdi's estimate can be too small. It asks for an explicit nonce, gas and gas price on every write.
- We first wrote our code from the first page. We now set the nonce, gas and gas price ourselves on every write. Gas is the larger of 1,000,000 and 2 x the estimate, capped at half a block.
- **Please:** put one answer on both pages.
- Our real writes set all three, so we do not know if leaving the fields out works.

## 4. We must build "first write wins" ourselves

- We want one record per seal. Arkiv has no unique field.
- So we read before we write, accept that two rows can appear, and keep the earliest `$createdAt`, then `$key`.
- Your skills say this too: a query before a create is not uniqueness.
- **Please:** add a way to refuse a second entity with the same value in a field, for one creator.

## 5. The faucet page tells you little before you sign in

- The page needs a connected wallet, a signature and a CAPTCHA.
- This is fine for stopping abuse.
- The amount per claim is not shown until you sign in. The docs pages we read do not state it.
- The docs pages we read do not say that you can send to another address. The page has a "Use a different address" button, and that is what a server wallet needs.
- **Please:** state both on the docs page.

## 6. A reserved word

- We wanted a field called `bytes`. The SDK refuses it, because it is a word in the query language.
- The "Define a schema" page says "such as" and gives only some of the words. The full list is on the query language page.
- **Please:** link that list from the "Define a schema" page.

## 7. Is the access key a secret?

- The SDK's own comment (`sdk/rabdi` in the MCP guide) says the key "is not a secret, as it ships with any app that talks to the chain".
- The guide `guides/known-issues` says "The full RPC URL contains the access key and is a secret."
- We read both. We have no key, so we did not have to choose.
- **Please:** give one answer in both places.

## 8. What should get an index?

- The guide `guides/quickstart` says "index only the columns the supported query filters or sorts".
- The "Define a schema" page says "index only what you filter on", and that a column with no index can still be sorted.
- We indexed `at` on all four kinds, because we sort on it. So those indexes serve no filter. See `schema.md`. The extra cost: not measured.
- **Please:** give one answer in both places.

## 9. The read methods page names the tag or the owner

- The "Read methods" page says: "Anyone can write entities with any attributes, so filter on your project's tag or on `$owner`."
- A tag stops nobody, because anyone can write our tag. An owner can be a fake too, as part 2 shows.
- **Please:** say `$creator` on that page, when you must trust the data.

## 10. We chose to send some writes again

- The MCP's `network_status` says `automaticWriteRetries: 0`. The write-safety skill says not to turn a retry policy into retries around `createEntity`.
- We do send again, in two places. `keepAfterWorld` in `records.ts` tries a seal's record up to 3 times. `keep` in `arkiv.ts` sends once more after a nonce refusal.
- Why: World takes a proof only once. If the record is lost after World accepted the proof, that person cannot make another one for it.
- The worst case is a second paid row. Every read keeps the first one created.

## 11. What was good

From real use. These are test rows; no demo event has rows yet.
- The first real writes worked, with no bug found in our Arkiv code.
- Public RPC: no 429 in 20 serial and 600 parallel reads, only slowness.

## 12. Not Arkiv's, but it cost us time

- Two proofs from the same person sent at the same instant: World refused one (`not-verified`), then accepted the very same proof a moment later. One at a time is safe.
- Without an access key, the public RPC adds 10 s per write, rounded.
- With every RPC call forced to 429, our routes answer `503 … "reason":"store"`, with no crash and no empty-but-OK answer. We forced this ourselves.
