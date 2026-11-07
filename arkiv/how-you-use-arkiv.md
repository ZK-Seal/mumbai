# How we use Arkiv

Questions from the prize: do the things you filter on, who can edit each entity, and when it expires fit what your product does? Does each feature change something users see?

## The flow

1. A person seals an edited photo and gets a hash. Nothing goes on Arkiv yet.
2. The person taps "Publish on zk-seal.eth". If they have no name, they choose a nickname and pass World, once. Our server writes one user row to Arkiv, and gives the app a session.
3. If an event is set, the app scans an ETHGlobal badge QR first. Nothing about the badge goes on Arkiv.
4. The person passes World for this photo, under its own action, because the World app makes one proof per person and action. World proves a unique human approved this exact photo; the session says which username. That session link is our server's word. Our server writes one record to Arkiv.
5. The app sends the picture. Our server stores it on Swarm and writes one pointer to Arkiv.
6. If the photo is at an event and the person has a name, our server makes the image's ENS name and writes one row for it to Arkiv.
7. Anyone opens the event's page or the gallery page. They read the rows from Arkiv and the pictures from Swarm.

The record and pointer writes ran for real, and the rows read back through our routes after a restart, with the file store empty. Those were test rows.
They used staging World proofs from the simulator and generated pictures, with a World proof for each photo. A later run wrote all four kinds under `test-run-b`, and they read back after a restart, while the chain side ran on a local fork.
The demo rows came after that, under the event `ethglobal`: 6 rows, 2 seals, 2 pictures and 2 names. We read these rows on 07.11.2026. Their names are on mainnet, and we read those from ENS.
The writing server runs on Armanc's Mac, and it is not public tonight. Anyone can read at https://zk-seal.eth.limo, the gallery page on Swarm, and at the read-only site with no keys, https://blank-demo-two.vercel.app/event/ethglobal. Both answered HTTP 200 on 07.11.2026.

## Each Arkiv feature, and what the user sees

| Feature | How we use it | What the user sees |
| --- | --- | --- |
| Filter on `event` | Lists all records of one event | The event page shows those photos, grouped by person. It counts only people with a name. A photo with no name counts as unnamed. The three photos under `test-run-a` share one pass and have no name, so today's code shows them as unnamed. Those are test rows |
| Filter on `pass` | Lists one person's seals | The list of photos behind one pass |
| Reading all user rows | Finds one person's name in our code. `label` and `pass` are indexed, but the code does not filter on them | The app shows "name being created" until the name is done |
| Filter on `hash` | Finds the record of one seal | The app can show "Authorised" when the web side answers with this record |
| Sort on `at` | Oldest first, or newest first | The order of the photos |
| Reading each kind's rows in the browser | The gallery page starts from six names, and adds any other name found in a real row. Trial rows stay out, unless the link names a trial event | The tree shows a name as real only with a row on Arkiv |
| Filter on the creator wallet | Every read filters on `$creator`, so it reads only what our wallet created | Fake rows with our tag should not reach the page. At the chain, the creator filter kept out one fake row handed to our wallet. Against the page itself this was not run |
| Read-only flag | Set when each entity is written. Our reads drop any row without it | The pages do not show it. It only keeps rows off the screen |
| 30-day expiry | Set when each entity is written | Each one drops out of the gallery 30 days after it was written |
| Public reads | Any app can run the same query | `event = str('ethglobal') AND $creator = addr(0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB)` returns 6 rows: 2 seals, 2 pictures and 2 names. Wallet: https://rabdi.explorer.arkiv.network/address/0x37D7D1bDA05129eBCb6e99Aa4ae106e8B75088eB |

## Does each choice fit the product

- **Filters.** People look up a seal, a person or an event. So `hash`, `pass` and `event` are indexed, and our reads filter on them. Six other indexes serve no filter: `at` on all four kinds, and `label` and `pass` on the user kind. Arkiv's docs say to index only what you filter on, and that sorting needs no index. So those six do not fit. The extra cost: not measured.
- **Who can edit.** Nobody can edit a record. A record must not change after the fact, so this fits. Our wallet can still delete a record, extend it or hand it over.
- **When it expires.** An event gallery matters for weeks, not for ever. So 30 days fits. Arkiv's docs say a shorter life costs less.
- **Who owns it.** One server wallet owns all entities. Each person does not own their own record. So a person needs no Arkiv wallet and no tGLM. The cost: the wallet shows who published, not which person. Each photo's World proof covers that part, and our server's session says which username.

## What stays public

Pass numbers, names and addresses stay readable by anyone for 30 days.
They can stay in the transaction history after that.
A name is a linkable pseudonym, not a real identity: it links that person's photos across events, by design. This demo is never safe for real protesters.
Our server holds the address keys and is the gate.

## Limits

World proves "approved by a unique human", not "taken by".
Our server does not check the seal. So a named person can file a made-up hash.
The link between a picture and its seal is the uploader's word, backed by their World proof for that photo. Our web server cannot open the sealed file.
