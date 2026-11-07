# Why Arkiv

## The current database, and what it is

Without Arkiv, each record is one JSON file on our own server (`FileStore` in `web/src/lib/records.ts`).
Only our server can read that folder and answer questions about it.

## What users would lose if the data stayed there

- **Reading without us.** Anyone can list an event's records with a public query. They do not need our server or our permission. If our server stops, the records can still be read until they expire.
- **Other views of the same event.** Another app can build its own gallery from the same records.
- **A check on later edits.** Records are read-only from the moment they are written. We cannot change a field later, and anyone can see that flag on the entity. In a folder on our server, nobody outside could see an edit.
- **A check on who wrote them.** Each entity shows the wallet that created it. A reader can ignore rows from any other wallet.
- **A built-in end date.** A record stops showing up after 30 days without any job on our side.

## A query you can run

This reads our records with no key, and without our server. Reads with no key share a small budget, so it can answer 429 for a while.

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
Wallet in the explorer: https://rabdi.explorer.arkiv.network/address/0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB

## What Arkiv does not give us

- Our wallet writes every record. So the wallet shows that our server published the record. It does not show which person wrote it.
- We can still delete a record, extend it or hand it over. Read-only protects its fields, not its presence.
- Rabdi is a testnet, so the data is not permanent.

## What we kept off Arkiv, and why

| What | Where it is | Why not on Arkiv |
| --- | --- | --- |
| The picture file | Swarm | An entity's binary data is limited to 128 KiB. Our pictures can reach 3 MiB. |
| The sealed file and its proof | The private backend, removed after the job | The backend is a private dependency. The sealed file is never published. |
| The original photo | Removed after the job | It is the user's photo, and everything on Arkiv is public. |
| Keys and upload tokens | Our server | Anything on Arkiv is public. |
| The World proof itself | Our server sends it to World to check. The record keeps only a pass, not the proof | Only the pass is needed to group a person's photos |
| The keys of the addresses that hold names | Our server | Anything on Arkiv is public. Our server holds these keys and is the gate |
| The badge | The phone checks it. Nothing about it goes on Arkiv | Arkiv needs nothing about it, and everything on Arkiv is public |

## Honest limits

1. World proves "approved by a unique human", not "taken by".
2. The link between a picture and its seal is the uploader's word, backed by their World proof for that photo. Our web server cannot open the sealed file.
3. Swarm retention through the public gateway is not guaranteed.
4. A name is a linkable pseudonym, not a real identity. This demo is never safe for real protesters.
5. The link between a photo and a named person is our server's session, not World's number.

A seal shows a proven edit of a signed original (our test key in this demo).
Our server does not check the seal. So a named person can file a made-up hash. The authorise step checks only the hash's format, so anyone can type a made-up hash and authorise it. The app sends a ticket from the sealing service, but the web side does not read it.
