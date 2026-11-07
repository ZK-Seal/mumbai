# Swarm

## What existed before the event

No Swarm code existed before the event. This repo's first commit is from 05.11.2026, and its Swarm code came after that.
The older private product is a private dependency. Its code has no mention of Swarm.
Everything below was added at ETHGlobal Mumbai.

## What lives where

| Where | What |
| --- | --- |
| Swarm | The plain result picture with its cover, as a JPEG. Never the sealed file. |
| Arkiv | The small records: users, authorisations, picture pointers and image names. |

The `blank-demo.pictures` entity's `ref` field holds the Swarm reference. The picture's hash and size sit beside it in `sha256` and `size`.

We do not encrypt. Each `ref` is a plain 64-hex reference, and the code takes no other length (`isSwarmRef` in `web/src/lib/swarm.ts`). An encrypted reference contains its key, so we would never put one in a public entity.

## One example

This row is under the event `ethglobal`. We read these rows on 07.11.2026.

- Arkiv entity key: `0x12cdd771ac68338e0275d51cc26a3bac1b01b870364ae0fedf3e7f488eec295e`
- Swarm reference: `b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e`. ENS on mainnet gives the same reference for `image1.ethglobal.events.zk-seal.eth`. We read that on 07.11.2026.
- Link to open: https://bzz.limo/bzz/b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e/
- Same reference on the gateway: https://download.gateway.ethswarm.org/bzz/b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e/
- Entity in the explorer: https://rabdi.explorer.arkiv.network/entity/0x12cdd771ac68338e0275d51cc26a3bac1b01b870364ae0fedf3e7f488eec295e

An older test row, under event `test-run-a`:

- Arkiv entity key: `0xfbe9f25e53427482e4441239a1fe3bd8a080df75f5fcd5302dcbff24bef5d70a`
- Arkiv transaction: `0x152bc4c342fcd041363420175debf9ecc6a809d5940c5f70137fee1c3ea38d20`
- Swarm reference: `1d1bc8a2dd539459fcb956c6d99a9d40849175306355ce113dce06a4e2b0fdde`
- The pointer's `sha256`: `933c0a9902a83d0a7cdf1704990da5ab0515dce04fb409dbc7f86d3c88c21d55`
- The pointer's `size`: 7,389 bytes.

## The gallery page is on Swarm too

The page itself is on Swarm, at the reference `533978621ae917a26304074ce8c2215c1be7b6de3b5ceed2a6ee6af8e0642fdf`. ENS's content hash on `zk-seal.eth` points at it, so https://zk-seal.eth.limo opens it. We read both on 07.11.2026. It may lag this repo's page until the page is uploaded again.

## Postage stamp, wallet and service

We use the public gateway, and we say so.

- We own no batch, and we did not buy one. If Arkiv's booth gives us a batch, we add it here.
- We send 64 zeros as the batch ID, and the public gateway `https://api.gateway.ethswarm.org` stores the file with its own stamp.
- So we cannot give the batch ID or the wallet that bought it, which the bonus asks for.
- Nobody promises how long the file stays. If that stamp runs out, the picture can vanish while its pointer still exists.

## The files

- Upload: `web/src/lib/swarm.ts` (`uploadPicture`). Route: `web/src/app/api/picture/[hash]/route.ts`. The app sends the file from `app/Sources/PictureUpload.swift`.
- Read: `gallery/index.html`, which fetches from the gateways in the browser, and `web/src/app/event/[event]/page.tsx`.
- The Arkiv side: `web/src/lib/arkiv.ts`, `web/src/lib/records.ts`.
- Settings: `SWARM_API_URL`, `SWARM_STAMP`, `SWARM_VIEW_URL`.

## Run one upload and one read

For the upload, you need four things:

- The web address of a server of ours that can write. The writing server runs on Armanc's Mac, and it is not public tonight. So nobody outside can run this upload tonight.
- The hash of a seal with a fresh record.
- The `picture_token` from the answer that made that record. Our server gives it once, only when it keeps a new record.
- A JPEG of 1,024 bytes to 3 MiB.

Upload:

```bash
curl -X POST "$WEB/api/picture/$HASH" \
  -H "Content-Type: image/jpeg" \
  -H "x-picture-token: $PICTURE_TOKEN" \
  --data-binary @picture.jpg
```

You should see `{"state":"stored","ref":"<64 hex>","url":"https://download.gateway.ethswarm.org/bzz/<ref>/"}`.

Read through our server. Use the read-only site as `$WEB`: https://blank-demo-two.vercel.app

```bash
curl "$WEB/api/seal/$HASH"
```

You should see `picture: {ref, url}` in the answer.

Read Swarm alone, without our server. You can run this today, with a reference above:

```bash
curl -o back.jpg "https://bzz.limo/bzz/$REF/"
shasum -a 256 back.jpg
```

The hash should equal the pointer's `sha256`.

## Real output

Upload: the raw output of that run is not in this repo. What it made is above: the pointer and its reference, and we read both.

Read: we read the example picture once from `bzz.limo`, on 07.11.2026. This is the real output:

```text
$ curl -sS -L --max-time 90 -o back.jpg -w "http %{http_code} bytes %{size_download} type %{content_type} time %{time_total}\n" "https://bzz.limo/bzz/1d1bc8a2dd539459fcb956c6d99a9d40849175306355ce113dce06a4e2b0fdde/"
http 200 bytes 7389 type image/jpeg time 1.444795
$ shasum -a 256 back.jpg
933c0a9902a83d0a7cdf1704990da5ab0515dce04fb409dbc7f86d3c88c21d55  back.jpg
```

The hash equals the pointer's `sha256`, and the size equals its `size`. That is the older test row.

We read the demo picture once too, on 07.11.2026, from the gateway: HTTP 200, 623,372 bytes, SHA-256 `eb5018ed44c7b92fb20ade0577249491a11cba83a7a9c8dfa5f1361358d6e124`. That equals its pointer's `sha256`.

## The moment in the demo video

See the video.

## What got in our way

- The public gateway is slow. In our test 62 KB took 2 s and 2.3 MB took 49 s, and our route gives up after 55 s. So the app tries to send 1 MB or less. A picture upload took 11 to 14 s, mostly Swarm.
- Access lists do not work through the gateway. `/grantee` answers 404. They need an own node.
- Depth 17 sounds large but is too small in practice: Swarm's table gives 44.70 kB effective there, and 112.06 MB at depth 19. We did not buy a batch.

## Limits

Swarm retention through the public gateway is not guaranteed.
The link between a picture and its seal is the uploader's word, backed by their World proof for that photo. Our web server cannot open the sealed file.
Our server does not check the seal. So a named person can file a made-up hash, and upload a picture for it.
World proves "approved by a unique human", not "taken by".
