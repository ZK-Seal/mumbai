# zkSeal at ETHGlobal Mumbai

An iPhone app, a web side and a gallery page. Together they show two things about an event's photos: what was changed, and how many people stand behind them.

Demo link: https://zk-seal.eth.limo. This opens the gallery page from its ENS name. It may lag this repo's page until the page is uploaded again.

The public read-only site: https://blank-demo-two.vercel.app/event/ethglobal.

Prototype, not audited.

## The problem

Anyone can edit a photo, and a viewer cannot tell what was changed. When part of a photo is covered, you usually have to take someone's word for what else changed.
And at a protest, one person with several phones can make it look as if many people saw it.

This demo answers two questions about an event's photos:

- **What was changed?** Each seal is a proven edit of a signed original (our test key in this demo). The picture beside it is the uploader's word.
- **How many people stand behind them?** Each name was proved once through World to be one human, so the gallery can say "N photos from M people".

This is a demo. It is never safe for real protesters. See "What is true in this demo".

## One picture

```text
  THE APP, on the phone
  1. Take a photo and draw over part of it
         |  the photo and the area
         v
  THE BACKEND, closed, not in this repo
  2. Turn the area grey, make the proof, check it
         |  a plain copy of the sealed picture, a hash, a verdict
         v
  THE APP
  3. Draw the cover on top. The person presses Publish
     The first time: a nickname and a World proof     ---->  WORLD
     Every photo: a World proof for this photo's hash ---->  WORLD
         |  the World proofs and the session, then the picture with its cover
         v
  THE WEB SIDE
  4. Check the proof with World, and the session
  5. Keep small records                               ---->  ARKIV
  6. Keep the picture                                 ---->  SWARM
  7. Make the person's name and the picture's name    ---->  ENS

  THE GALLERY PAGE, in any browser, with no server of ours
  8. Read the records from ARKIV and the pictures from SWARM.
     Show each event's photos and how many named people stand behind them.
     The app opens this page at the photo, and the page follows it until it is on chain.
```

## How the app and the web side work together

| Part | Where | What it does |
| --- | --- | --- |
| App | `app/` | Takes the photo, draws the cover, opens the World ID app, and shows the result |
| Backend | Closed, not in this repo | Seals the photo and checks the proof. It removes the files after the job |
| Web side | `web/` | Checks World proofs, keeps records on Arkiv, keeps pictures on Swarm, and makes the names |
| Gallery | `gallery/` | One page that reads Arkiv and Swarm from the browser. It shows an event's images or a person's images, follows one photo from a link, and asks ENS which names are on chain |
| Contracts | `contracts/` | Registrars, written and fork-tested, not wired |

1. **Seal.** The person draws over part of a photo. The backend seals it and returns a plain picture and a hash.
2. **Publish, the first time.** The person chooses a nickname and proves through World that they are one human. The web side refuses a name that is taken, makes the name in the background, keeps a user row on Arkiv, and gives the app a session.
3. **Publish, each photo.** If an event is set, the person scans a badge once for that event. The person approves this photo's hash through World. With a session, the web side keeps a record on Arkiv under the person's name. With no session, the photo stays unnamed. The app sends the picture with its cover. The web side puts it on Swarm, keeps a pointer on Arkiv, and makes the image's name. The app then opens the gallery page at this photo.
4. **Read.** The gallery page reads Arkiv and Swarm, and shows each event's images with their names and their people's names.

## What each partner adds, and what its prize asks

One section each. In the tables, **There** means it is done today. **Not there** means it is not done yet.

**Words used here.**

- **Pass:** the number from a person's World proof. It stays the same for one person and one action, and it does not say who they are.
- **Session:** a string our server gives the app when a person gets a name. It stands for that name.
- **Fork:** a local copy of mainnet, for trying things with no real money.
- **Custodial:** our server holds the keys, not the person.
- **Registry:** the contract that lists the names at one level of the tree.
- **Resolver:** the contract that holds a name's records.

## ENS

Prize: Best Integration of ENSv2 into an Existing Project.

**How we use it.** ENS is used like a folder tree. People and pictures get ENS names, with records on them. A name under `users` exists only after our server has checked a person's World proof. A name under an event exists only after a named person approved that seal through World.

```text
<root>.eth
├─ users.<root>.eth                        a name here = one World proof (test identities in this demo)
│  ├─ <nickname>.users.<root>.eth  <---->  address A     name and address point to each other
│  └─ <nickname>.users.<root>.eth  <---->  address B
└─ events.<root>.eth
   └─ ethglobal.events.<root>.eth          one registry for this event's pictures
      ├─ image1.ethglobal...       ----->  address A     picture on Swarm, seal's hash, person's name
      └─ image2.ethglobal...       ----->  address B
```

A person's name is `<nickname>.users.zk-seal.eth`. The web side's root is one setting, `DESK_NAME`, with `armanc.eth` as its default. The app shows whatever name the web side returns.

**What is on mainnet.** We read this through the Universal Resolver on 07.11.2026, at block 26359547.

- The first user: address `0x965a865FcCB51A0Df34B9fb47a02e613F3B2f0C1`. That address's primary name points back to the first user's name.
- `image1.ethglobal.events.zk-seal.eth`: its content hash is the Swarm reference `b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e`. Its text `eth.zk-seal.seal` holds the seal's hash `06eb02d69eac3767c5eca6c6a8a03356b4f8a5169de00cf5798e803e68ec1d92`, and `eth.zk-seal.by` holds the first user's name.
- `image2.ethglobal.events.zk-seal.eth`: Swarm reference `16006fe172040f9f112e452de114da4b7b5dd1478711f55fd7e3931d4268ac76`, seal's hash `16cc599c83b7ce3e6f029687622a6e7b6ac7b8180d1f9a01261784ba041646a7`, by the same user.
- Our tree's resolver: `0x97a649189fBCd263b5997b5920F7d9Db51a85E88`.
- Our registries: under the root `0xEa0d3fDeE5dAFbb42b4eC8D4d5bd64C7Dcf192cf`, `users` `0x17157795D92f0FbF16aE34bfcc6ee71D3014269B`, and `events` `0x8c5Ed979804AA147aE4Ec77D74e530591411b700`.
- `zk-seal.eth` itself: its content hash is the Swarm reference `533978621ae917a26304074ce8c2215c1be7b6de3b5ceed2a6ee6af8e0642fdf`, the gallery page. https://zk-seal.eth.limo answered HTTP 200 with it.
- The root name is not on our registries. It sits in ENS's own `.eth` registry, with another resolver, `0x5f8beFDD28bf5026Bf5104e367FFe0EfE74d81EE`.
- `zk-seal.eth.limo` may lag this repo's page until the page is uploaded again. When we read it, it served the same bytes as `gallery/index.html` at commit `edcd0af`, not the newest.

**What it adds to the project.**

- The tree itself says which names passed World and what they published. Anyone can read the tree on mainnet, without asking us.
- A person and a picture each get a name a reader can use, in place of a long hash.
- In ENSv2 a name can have its own registry. So each level here is its own contract: one registry for people, one for events, and one for each event's pictures. A new event is one new registry, and its names stay apart from every other event's.
- One resolver of ours holds the records: the Swarm reference, the seal's hash and the person's name. So a name leads to its picture.
- A person's address points back to their name as a true ENS primary name, set through the default reverse registrar. So a wallet or a site can show it.

**What its prize asks for, and where each ask is met.**

| The prize asks for | Where | State |
| --- | --- | --- |
| "Integration must use ENSv2 on Ethereum mainnet" | `web/src/lib/tree.ts`. Real names under `zk-seal.eth`: see "What is on mainnet", above | There |
| "integrate it into an existing project" | zkSeal is the existing project. The tree is in `web/src/lib/tree.ts` | There |
| "It should be clear how ENSv2 improves the project" | "What it adds to the project", above | There |
| "not just include hard-coded values" | A name comes from a real check: `registerUser` in `web/src/lib/tree.ts`. The gallery starts from six names, and each shows as real only with a row on Arkiv. Any other name found in a real row is listed after them. Clicking an event or a person shows their images | There |
| "not just a cosmetic add-on" | Names come from real checks. The gallery lists names from Arkiv, and marks one "on chain" only if ENS on mainnet holds its exact record, read from the browser through the Universal Resolver | There. We saw the mark on real mainnet names, on the repo's page |
| "must have a link to a live demo" | The demo link at the top | There. `zk-seal.eth.limo` opens the page from its ENS name |
| "code needs to be open source and accessible on Github" | This repo, under MIT | There |

**Its limits.**

- Our server is the registrar. It checks World, then our bot wallet makes the name. No contract makes that check today.
- Our server derives each person's key from their pass and the bot's key. One leak gives both. Our server can sign for every person. In the intended design the key stays on the phone.
- The owner and the bot both hold every role today, so the bot could remove the owner.
- A picture's name shows that a named person filed that hash. Our server does not check the seal, so the hash may be made up.
- An event's own ENS name opening the gallery page: **not there**. `ethglobal.events.zk-seal.eth` has no content hash. The root's name does.
- Anyone can choose any name the web side accepts, so a name can look like another person's. A name shows nothing about who chose it.
- A name that starts with `test-` stays out of the gallery's list, because our trial rows start that way.
- A name that was never registered can still answer through the parent's resolver. So read "exists" from the owner, in the registry, not from a resolver answer.

## Arkiv

Prize: Build on Arkiv (existing projects).

**How we use it.** Arkiv holds our small records, in four kinds of read-only row: users, approvals, picture pointers and image names. Our web server's wallet writes them all. The gallery page and the web side's event page read them. Every read keeps only rows our wallet created read-only. Before the event, nothing here used Arkiv. Everything on Arkiv is new.

**What it adds to the project.**

- Anyone can list an event's records with a public query, without our server and without our permission. If our server stops, the records can still be read until they expire.
- Another app can build its own gallery from the same records.
- Records are read-only from the moment they are written, and anyone can see that flag. We cannot change a field later. We can still delete a record, extend it or hand it over.
- Each row shows the wallet that created it, so a reader can ignore rows from any other wallet.
- A record stops showing up after 30 days, with no job on our side.

**The wallet, the rows and one query.**

- Wallet that wrote the entities: `0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB`.
- Wallet in the explorer: https://rabdi.explorer.arkiv.network/address/0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB
- Seal record: https://rabdi.explorer.arkiv.network/entity/0xf25af966488981a92dbc8d6c37278744b666f03b86c7a39dbad25bff0b42f417
- Picture pointer: https://rabdi.explorer.arkiv.network/entity/0x12cdd771ac68338e0275d51cc26a3bac1b01b870364ae0fedf3e7f488eec295e. It points to the Swarm reference `b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e`.

One query you can run. It needs no key, but reads with no key share a small budget. When it runs out, Arkiv answers 429 with `ANON_COST_LIMITED`, and `Retry-After` says how long to wait. We saw `limit=10000` and 402 s.

```bash
curl https://rpc.rabdi.db-chain.testnet.arkiv.network \
  -H "content-type: application/json" \
  --data @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"arkiv_query","params":[
 "event = str('ethglobal') AND $creator = addr(0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB)",
 {"select":{"key":true,"creator":true,"expiresAt":true,"creationFlags":true,"attributes":true},"limit":"0xa"}]}
EOF
```

You should see 6 rows: 2 seals, 2 pictures and 2 names. Each row shows `creator`, and `creationFlags` with `readonly` true. We read these rows on 07.11.2026. Older test rows are under `test-run-a` and `test-run-b`.

**What its prize asks for, and where each ask is met.**

| The prize asks for | Where | State |
| --- | --- | --- |
| "An existing project in ETHGlobal's Continuity batch" | On ETHGlobal's form, not in this repo | We entered on the Continuity track |
| "The Arkiv part is new work done at ETHGlobal Mumbai" | The first Arkiv commit, 06.11.2026, in `web/src/lib/arkiv.ts` | There |
| The README says "what existed before the event and what you added" | "Old work and new work", below | There |
| Writes to the current testnet | `web/src/lib/arkiv.ts`, on Arkiv's Rabdi testnet | There |
| "at least one feature users see reads its data from Arkiv" | `eventPhotos` in `web/src/lib/records.ts`, and `kindQuery` in `gallery/index.html` | There, at the demo link at the top |
| The README gives "the wallet address(es) that wrote your entities" | Above | There |
| The README gives "one query we can run" | Above | There |
| `schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` | `/arkiv/` | There |
| Answers "with links, numbers or a query we can run", from real rows | `/arkiv/` | There, under the event `ethglobal`. We read them |
| "A public repo with an open-source license" | This repo, under MIT | There |
| "Say how you used AI, as ETHGlobal's rules require" | "How we used AI", below, and the form | There |

## Swarm

Prize: the Arkiv + Swarm bonus (existing projects).

**How we use it.** Swarm holds the picture files: the plain picture with its cover, as a JPEG, never the sealed file. The `ref` field of a `blank-demo.pictures` row on Arkiv holds the Swarm reference. The gallery fetches the picture from Swarm's gateways in the browser. No Swarm code existed before the event.

**What it adds to the project.**

- An Arkiv row is small: its binary data is limited to 128 KiB, and our pictures can reach 3 MiB. So the file goes to Swarm, and Arkiv keeps where it is and its hash.
- Anyone can fetch a picture from Swarm without our server, and compare it with the hash on Arkiv.

**Its limit.** We use the public gateway. We own no batch and did not buy one, so the gateway stores the file with its own stamp. How long it keeps a file is not promised, so a pointer can outlive its picture. Swarm's notes say a fresh upload can show "Forbidden" on a public gateway.

**What its prize asks for, and where each ask is met.**

| The prize asks for | Where | State |
| --- | --- | --- |
| "uses both Arkiv and Swarm" | The picture on Swarm, the pointer on Arkiv | There |
| `swarm.md` | `/arkiv/swarm.md` | There |
| "say what existed before the event" | "Old work and new work", below, and the line above | There, in `/arkiv/swarm.md` |
| "which entity field holds the Swarm reference" | `ref` on `blank-demo.pictures`, in `web/src/lib/arkiv.ts` | There, in `/arkiv/swarm.md` |
| "One Arkiv entity key and the Swarm reference it points to, with a link" | The picture pointer in the Arkiv section, and https://download.gateway.ethswarm.org/bzz/b5b525acdbe457e559283d24f9fc5bb8ca330d7aff7457c9b219d2259b49b56e/ | There |
| "postage stamp batch ID" and "the wallet that bought it (or who gave you the batch)" | `web/src/lib/swarm.ts` sends 64 zeros, and the gateway uses its own stamp | **Not there**. We own no batch |
| "the Bee node or service you uploaded through" | The public gateway, `https://api.gateway.ethswarm.org`, in `web/src/lib/swarm.ts` | There, in `/arkiv/swarm.md` |
| "The files in your repo that upload to Swarm and read from it" | Upload: `uploadPicture` in `web/src/lib/swarm.ts`, and `web/src/app/api/picture/[hash]/route.ts`. Read: `gallery/index.html`, and `web/src/app/event/[event]/page.tsx` | There, in `/arkiv/swarm.md` |
| Steps for one upload and one read, and "what we should see" | `/arkiv/swarm.md` | The steps and one real read are there. The upload's raw output is not |
| "What got in your way with Swarm" | `/arkiv/swarm.md` | There |
| Never store an encrypted reference in an entity | `isSwarmRef` in `web/src/lib/swarm.ts` takes plain 64-hex references only | There |

## World

Prize: [Cont] Best Use of IDKit.

**How we use it.** A person passes World once for the name, and again for every photo they publish. World proves a unique human approved this exact photo; the session says which username. A photo with no session has no username. The app opens the World ID app through World's Swift package, IDKit, pinned to 4.2.0. The web side checks each proof with World before it writes anything (`web/src/lib/world.ts`).

**What it adds to the project.** Without World, one person with several phones looks like a crowd. With it, a page can count how many people stand behind an event's photos, and it does not need to know who they are.

**The moment that needs trust.** A photo joins an event's public list, and the page counts how many people stand behind the photos. We need to know one human stands behind a name. We do not need to know who they are. The people count comes from the one-per-person proof at the name step.

**The credential.** Proof of Human. It is the least that is enough, because what we need is one person per name, and not who they are. World's docs say it shows "The user is a unique human", and it says nothing else about the person. A passport or an identity check would tie a public name to more about the person, with no gain for the count. World's docs call Selfie Check medium assurance, and we did not test it. The identities in this demo are test identities, which World's prize page allows.

**What it proves.** "Approved by a unique human", not "taken by". The identities in this demo are test identities.

**One action per photo.** The World app makes one proof per person and action, and refuses a second. So each photo has its own action, drawn from its hash. A session from our server says which username the photo goes under. That link is our server's word.

**The other path.** A cancelled or refused proof gives no name and sends no picture. On the name step, the app shows "World did not finish" with World's word. On a photo with no name, it shows "Not authorised" with World's word.

**Debrief.**

- Time to first success: not measured.
- Friction: the simulator accepted a second proof for one action, but the World app refuses it with `nullifier_replayed`. We found this only on a real phone, then gave each photo its own action. One sandbox account showed "V4 protocol and credential issuance must both be enabled for this account" and could not be used. A new sandbox credential took up to an hour. Two proofs sent at the same instant: one was refused, then the same proof was accepted a moment later.
- Our own session, not World's: World's docs say "Do not carry over a uniqueness nullifier as a persistent user identifier", and they offer session proofs. Those do not support the older proofs the sandbox gives. So we use our own session, and this differs from World's docs.
- Missing, from our experience tonight: what the simulator does not show. The simulator accepts a second proof for one action, and the World app refuses it, so we learned this only on a real phone. When a request did not allow older proofs, the proof from a sandbox account never came back, and nothing said why. We read the package's source to learn which phone app answers which environment.
- The one improvement with the greatest impact, from our experience tonight: make the simulator refuse a repeat proof for one action, as the World app does.

**What its prize asks for, and where each ask is met.**

| The prize asks for | Where | State |
| --- | --- | --- |
| "Integrate IDKit in a functioning application" | `app/Sources/WorldStep.swift`. On a phone, a person got a name through World, and photos were filed under it. That run is Armanc's word. The names are on mainnet, and we read them | There, with test identities |
| "verify the result on the server or onchain" | On the server: `web/src/lib/world.ts`. A contract for it is written, not wired | There, on the server |
| "the specific product event requiring trust" | "The moment that needs trust", above | There |
| "the minimum sufficient assurance" | "The credential", above | There |
| "one meaningful alternative path" | `app/Sources/NameScreen.swift` and `app/Sources/ResultScreen.swift` show World's word | There in the code |
| Debrief: "friction encountered" | "Debrief", above | There |
| Debrief: "time to first success" | "Debrief", above | Not measured |
| Debrief: "missing capability or documentation", and "the one improvement" | "Debrief", above | There, from our experience tonight |

## Old work and new work

| | What | Where |
| --- | --- | --- |
| **Old, before the event** | zkSeal itself: an older private product that proves how an edited photo follows from a signed original, with the proved grey edit. The zkSeal logo. The design of our earlier app | The product is not in this repo. The logo files are |
| **New at ETHGlobal Mumbai, open** | The app, the web side, the gallery page, the contracts, and all use of World, ENS, Arkiv and Swarm | This repo. Its first commit is from 05.11.2026 |
| **New at ETHGlobal Mumbai, closed** | A service that runs the older product for the app | Not in this repo, because it uses that private product. The app talks to it over HTTP with an access word |

## How we used AI

We built this together with AI tools. We designed the system, chose its security rules and limits, worked on the code with them, directed the work, and tested the flow on real phones. AI tools helped write the phone app, gallery page, contracts, server and docs.

## What is true in this demo

**The gallery page does not say these, so they are here.**

- Covers are drawn by the app and not proved.
- It is not a privacy guarantee.
- A name is a linkable pseudonym, not a real identity.
- Our server holds the address keys and is the gate.
- A picture's link to its seal is the uploader's word.

**What a seal is.** A seal shows a proven edit of a signed original (our test key in this demo). Our test key signs, not a camera. So it does not show that a camera took the photo.

**It is not zero knowledge.** The demo runs in plain mode. Edits under zero knowledge are in progress.

**Who decides.**

- The registrar is our server, not a contract. The server checks the World proof with World, then our bot wallet makes the name.
- The contracts are written and fork-tested, not wired. The path we run does not send through them. Their check is a signature from a key on our server, not a check of the proof. A contract that checks a World proof itself is written for later.
- No contract checks a seal's proof. That proof's size and cost rule it out on mainnet today.
- The backend checks the seal. The web server cannot see the sealed file.
- An image's name means this: World proves a unique human approved this exact photo; the session says which username. That person sent this picture.
- Whoever holds a person's session and can pass World can publish under that name.
- The web side also accepts a photo with a session and no World proof, as a fallback. The app does not use it. So the proof on every photo is the app's rule, not the server's.
- **Our server does not check the seal. So a named person can file a made-up hash.**
- The authorise page checks only the hash's format, so anyone can type a made-up hash and authorise it.
- The app sends a ticket from the backend, and the web side does not read it.
- The badge check is in the phone only. See "A badge for an event".

**What can be traced.**

- By design, one person has one name and one pass, and they link all that person's photos across events. With test identities, this is not a real check of one human.
- The pass is in a public text record, and names stay on a public chain.
- **This is never safe for real protesters.** Anyone who learns who is behind one name can see all that person's photos.

**Photos with no session.** The gallery shows them as unnamed and does not count them as people.

**What is only for this demo.**

- Our test key signs the photo.
- The World identities are test identities.
- The keys are custodial, as above.
- Swarm is used through the public gateway, with no batch of our own. How long it keeps a file is not promised.
- Arkiv is a testnet, and a record lives for 30 days.

**What can go wrong when it runs.**

- A lost or rotated bot key changes every user address, and the tree then reads as not set up.
- A leak of the bot key gives every user key.
- The bot can remove the root's owner from the registries, because it holds every role.
- A session has no expiry, and nothing caps what the bot spends for one session.
- A fresh upload can show "Forbidden" on Swarm's public gateway.
- Rotating the World signing key voids every session and picture token.
- World's mode is staging unless `WORLD_ENVIRONMENT` says otherwise. Set it on every deployment.
- The bot's queue lives in one process.
- Without an Arkiv access key, each write takes about 10 s more.

## What the proof shows

- The sealed picture follows from a signed original by the stated change.
- Only the listed rectangles were edited. The rest comes from the signed original, re-encoded at lower quality.

## What the proof does not show

- **It is not a privacy guarantee.** The file still carries a map of the area, which can show outlines, even writing on plain paper, and the original's hash.
- **It does not show that a camera took the photo.** In this demo our test key signs the photo after the app sends it. That key is not on any trust list.
- **It does not cover the look on the screen.** The mask and the tiles are drawn by the app.
- **The authorise page does not check the seal.** It checks only the hash's format, so anyone can type a made-up hash and authorise it.
- **You cannot check it yourself.** The check is our server's word. The backend checks the proof, and the app shows the picture only if the check passed. The phone cannot recompute the hash, because it never holds the sealed file. The backend removes that file after the picture is fetched, or after 600 s if it is never fetched, and a service stop in that window can leave it until the next start. Once it is removed no one holds it, so the hash can no longer be checked against the file.

## What the app does

The app's screens do not explain any of this, so the facts are here.

1. You take a photo, or choose one. The app draws it at 2600 px on its long side at most.
2. You draw a closed shape with a finger. A thin line follows the finger. When the finger lifts, the line goes away and the shape grows out to a 16 px grid, so the grid cells cover all of it. Two fingers zoom in, up to 5 times, and move the photo, and two quick taps go back. Lines land on the same grid at any zoom. A line too small to hold a cell adds nothing. You can draw more shapes: overlapping ones join, "Undo" removes the last one and "Clear" removes them all.
3. The app covers each area on the screen, with a yellow mask or with mosaic tiles.
4. "Blank this area" sends the photo and the area to the backend, which is a private dependency and is not in this repo. So the photo goes off the phone to our own server.
5. The answer is a plain copy of the sealed picture, a hash and a verdict. The picture appears only after the check passed and the whole answer matches what the app sent. Any other answer shows one fixed line and no picture. The screen shows no line saying it passed. The sealed file cannot be downloaded. The backend removes it and the photo after the picture is fetched, or after 600 s if it is never fetched. A service stop in that window can leave them until the next start.
6. After a result, "Start over" also takes the photo off the screen.

## The Publish button

"Publish on zk-seal.eth" shows under "Start over", with the picture, only if a web address is set. The picture shows only after the seal's check passed. The address comes from Settings or from `WEB_URL` at launch, and it is not in this repo.
Its words name the root the tree is moving to. Until that switch is real, names go under `armanc.eth`, and the app shows the name the web side returns.
Pressing it runs these in order: the nickname, if the person has no name yet; the badge, if an event needs one; then the photo's own World step.
If the web side is ready, the World step goes to the World app and back, with no page between, through World's IDKit package, pinned to 4.2.0. The package's result goes to the web side unchanged. "Authorised" shows only after the web side answers that it verified the result, or answers with a record for this hash. A refusal or a failure shows "Not authorised", and the button stays. If the web side gives its own words for a refusal, the app shows those words as they are. If it refuses the saved session, the app forgets that session, and the next press goes on with no name.
After "Authorised", the app sends the picture and opens the site at this photo in the browser. The site's address comes from `SITE_URL` at launch or from Settings. With neither, it is `https://zk-seal.eth.limo/`.
If the web side cannot be read or the World app cannot be opened, it opens that page in a sheet inside the app.
It sends the hash, the edit, the size and `from=app` to that page, in the link, with no photo. It also sends an event's short name, chosen above the button or in Settings, or set with `EVENT_SLUG` at launch, but only if it is 3 to 40 lowercase letters, digits and hyphens, with no hyphen first.
The page comes back through a `blankdemo://` link, and the app does not trust that link alone. "Authorised" shows only if the link names this hash and the web side then answers with a record for it. Anything else shows "Not authorised", and the button stays.

## Your name

On the first Publish, and at any time from Settings, the app asks for a nickname. It sends what the person typed, and the web side alone decides if it can be a name. If not, the app shows the web side's own words. From then on the app uses the web side's own form of the name. Closing that step goes back to the button, and nothing is sent. The person proves in the World app that they are one human, and the web side checks that and makes an ENS name for them, in the background. The app keeps the name on the phone and shows that it is being created until the web side says it is done. If the World app cannot be opened from here, the app opens the web side's join page in a sheet, and believes the page's way back only when the web side then lists the name.
The registrar is our server, not a contract. The name goes on a public chain and stays there, and it links that person's photos across events.
When the web side is making an ENS name for a picture, the result shows "name being created" under "Authorised", then the name. If it is still not done after about 90 s, the app asks once more with the same token.

## A badge for an event

If an event is set, the app scans an ETHGlobal badge's QR code with the camera before the first photo's World step for that event. It accepts only an https link on ETHGlobal's own hosts, `ethglob.al` and `ethglobal.com`. The phone follows that link once, with no cookies, and passes the badge only if it lands on a page under `ethglobal.com`, not on the site's front page. It never shows or keeps the link or the page. It sends only the link's SHA-256 to the web side, as `entry`.
This is the phone's own check. The web side does not check the badge today, so anyone can get past it without the app. It shows only where the link lands, so a code that links straight to another ETHGlobal page passes too. It does not show that the person holds the badge: a badge is worn in public, and anyone who photographs it can copy the link. The link holds a short code, so its SHA-256 can be guessed. It is not a secret.

## The picture after authorising

After the web side verifies a new authorisation, the app sends it the picture with its cover, and the web side puts that picture on Swarm, where anyone can read it. How long Swarm keeps it is not promised.
The app makes that picture only from the backend's plain copy with the cover on top, flattened into one layer, with no metadata. It never uses the photo on the phone or the sealed file.
The link between a picture and its seal is the uploader's word. A failed send does not change "Authorised". It shows one line and a way to try again.

## The cover on the screen

"Cover" in Settings chooses a yellow mask, the default, or mosaic tiles.

- The mask is a flat yellow area with a yellow face on it, sized to the area. The face is a fixed picture in the app, and the app reads no pixel of your photo to draw it.
- The tiles take their colours from the pixels around the area. The app never reads a pixel inside it.

Both are drawn by the app. What you see in the area is made up. Neither is in the sealed file, and neither is proved. In the sealed file the area is plain grey, and the app sends the same edit with either choice. On the screen, both have a rounded edge and reach a little past the sealed cells.

## How to build it

### The app

You need Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen). The project file keeps an older working name.

```sh
cd app
xcodegen generate
open BlankDemo.xcodeproj
```

Choose your own signing team in Xcode, then run on a phone with iOS 17 or later.

The app needs the backend's address and an access word. Enter them under Settings in the app, or set `SERVICE_URL` and `SERVICE_WORD` when you launch it. Neither is in this repo. Without the backend you can still draw and see the cover, but you cannot send.

The app allows plain HTTP on a local network, for the backend and for the web address. Over plain HTTP the photo, the access word and the picture are not encrypted, so use a link you trust. With a plain HTTP web address the app never opens the sheet or the join page, because those pages need a secure address.

### The web side

```sh
cd web
npm install
npm run dev
```

Its settings are environment variables, read in `web/src/lib/`. No key is in this repo. The read-only link runs with `ARKIV_OWNER` set and no key. It reads Arkiv. With no key, its `/tree` page shows no tree.

### The gallery page

`gallery/index.html` is one file. Open it in a browser. It reads Arkiv and Swarm by itself. With `#seal=<hash>` in its address, it follows that one photo, and stops when the photo is done. If it cannot read ENS, it shows no "on chain" mark, and works as before.

### The contracts

```sh
cd contracts
./install-deps.sh
forge test
```

The fork tests read mainnet through `ETH_RPC_URL`, or through a public node.

## What is not in this repo

- The backend and the older product it runs.
- The backend's address and access word, and every key.
- Any photo or sealed file.

## Fonts

Public Sans, under the SIL Open Font License. The licence is beside it in `app/Fonts`.

## Licence

The code is under MIT, see `LICENSE`. The font is under its own licence. The zkSeal logo and the mask image are not covered by MIT.
