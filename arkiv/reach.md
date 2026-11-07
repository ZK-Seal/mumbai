# Reach

Questions from the prize: who uses your product today, will they use the part on Arkiv, and will it ship to them after Mumbai?

## Who uses the product today

Today nobody outside our team of two uses it.

The product is an older private one that proves how an edited photo follows from a signed original.
It is a private dependency, and it is not in this repo.
This repo is a prototype, not audited.

## Who the Arkiv part is for

- **People at an event** who publish photos and want to show that one real person stands behind them.
- **Readers** who want to see all the pictures from one event in one place.
- **Other apps** that want to build their own view. They can read the same records without asking us.

A name is a linkable pseudonym, so this demo is never safe for real protesters.

We have not offered it to anyone yet. For now it is a demo.

## Can they use it today

To read, yes: https://zk-seal.eth.limo, the gallery page, and https://blank-demo-two.vercel.app/event/ethglobal, the read-only site. To publish, no: the writing server runs on Armanc's Mac, and it is not public tonight.

- Link to the event page: https://blank-demo-two.vercel.app/event/ethglobal
- Entities under the event `ethglobal`: 6. That is 2 seals, 2 pictures and 2 names. We read these rows on 07.11.2026.
- People behind them: 1, the first user, by the gallery's own count on 07.11.2026.

Our earlier test rows, for comparison, as they were before the demo rows.
- Entities: 10 from our wallet. That is 4 seals, 4 pictures, 1 user and 1 name.
- Different passes: 2. One under `test-run-a`, and one under `test-run-b`.
- Read on 07.11.2026.

These numbers come from a query that anyone can run. See `schema.md`.

## Will it ship after Mumbai

Whether it ships after Mumbai is not decided.

Facts that limit this today:
- Arkiv's Rabdi network is a testnet.
- A record lives for 30 days.
- The picture store through the public Swarm gateway has no promise of how long it keeps a file.
