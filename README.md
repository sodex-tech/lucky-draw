# Lucky Draw

A general-purpose, verifiable lucky draw for live shows. Import a ticket list,
define your prizes and rounds in Settings, then draw round by round — each round
ends with a congratulations popup naming the prize and its winners.

## Run

```bash
npm install
npm run dev
```

Open the URL printed by Vite and visit `/variants/c/`.

## Test

```bash
npm test
```

## Set up a draw

Everything is configured in **Settings** (it opens automatically until a ticket
list is imported):

1. **Program** — the title shown in the top bar and the browser tab.
2. **Tickets** — upload a CSV/TSV, paste a list, or load the bundled
   `ticket-map.csv` sample. One ticket per row. When the file has a header, a
   ticket column (`ticket_number`, `ticket`, `id`, `serial`, `no`…) and an
   optional name column (`name`, `holder`, `user`, `nickname`…) are detected
   automatically; without a header the first column is the ticket and the second
   is the name. Ticket values may be any string — numbers, `A-0042`, handles.
   Duplicates are rejected.
3. **Prizes** — as many as you like, each with an icon, a name and a
   description. Upload a picture for the icon (it is downscaled to 192px and
   stored with the config) or type an emoji.
4. **Rounds** — as many as you like, drawn top to bottom and reorderable. A
   round can hand out several prizes at once: add a prize to the round and set
   how many winners it draws.

Settings can be exported as `lucky-draw-config.json` and imported again — that
file is also what the offline verifier needs. Saving changed settings clears any
results already drawn.

The config and the ticket list are cached in `localStorage`, so a reload during
a live show keeps the setup and the winners drawn so far.

## Draw mechanism

1. A public seed is entered before drawing. Using a public, unpredictable value
   (for example, the hash of a recent on-chain transaction) is recommended so
   the seed cannot be pre-computed. The seed is locked once the first round
   starts, so the same seed drives every round.
2. Tickets are sorted into a canonical order before drawing, so the same ticket
   set always produces the same winners no matter how the source file was
   sorted.
3. Winner selection is fully deterministic:
   `SHA-256(public seed + ":" + round id + ":" + prize id + ":" + item index)`
   seeds an sfc32-style PRNG (see `createSeededRandom` in `draw-engine.mjs` for
   the exact variant), and each winning ticket is removed from the pool
   immediately. The same dataset, config and seed always reproduce the same
   winners.
4. Every confirmed ticket is removed from later rounds, so one ticket cannot win
   twice — including when the same prize is drawn twice in one round.
5. Each round can be copied with its prizes and winners, and the complete result
   can be exported as CSV.
6. The exported CSV contains draw order, round, prize, ticket number, holder
   name, **the public seed**, the dataset hash and the UTC confirmation time of
   each round — everything needed to replay the draw.

## Verify a draw independently

Anyone can reproduce the full result offline with Node 20+, given the published
seed, the exported config and the ticket list:

```bash
node verify.mjs <public-seed> lucky-draw-config.json tickets.csv
```

It prints the dataset SHA-256 and every winner in draw order. Compare them
against the exported CSV: the seed, the dataset hash and every ticket number
must match. Prize icons are not part of the draw, so a config with the icons
stripped out verifies just the same.

## Key files

- `draw-engine.mjs`: ticket parsing, config validation, winner selection, CSV export.
- `verify.mjs`: standalone replay tool for auditing a draw result.
- `ticket-map.csv`: a 27,283-row sample ticket list.
- `variants/c/app.mjs`: settings editor, session state, countdown, sound, congratulations popup, UI orchestration.
- `variants/c/styles.css`: virtualized 2D ticket wall and responsive layout.

## SoDEX Treasure Box preset

In Settings → Prizes, choose **Use SoDEX preset** to load Common, Uncommon,
Rare and Super Rare with their original card images and reward descriptions.
This replaces prizes and rounds in the settings draft, keeping the title and
imported tickets. The Sep 23 live draw has four rounds: Common ×100, Uncommon ×20, Rare ×2,
then Super Rare ×1 (123 boxes total). Counts remain editable before saving. Cancel discards the draft. Saving a changed setup follows
the existing confirmation flow when draw results exist.

The reward ranges ($1–$8 / $10–$200 / $100–$1,300 / $400–$10,000, paid as Wealth
assets) and original artwork come from `sosovalue-tech/sodex-next`, commit
`b39f852b6547652523565f8f813f861565ffc254`, specifically
`src/features/treasure/domain/constants.ts`, `components/BoxArt.tsx` and
`src/assets/images/treasure/box-*-card.webp`. These are bundled preset values,
not live reward quotes. Images are embedded WebP data URLs so saved and exported
configurations remain portable, including on GitHub Pages.

## Wallet snapshot import

Import snapshot CSVs with `wallet,tickets,boxes,common,uncommon,rare,superrare,token_ids`
directly. The whitespace-separated `token_ids` cell is expanded to one draw entry
per token ID. `wallet` is retained as the holder in results and exported CSVs;
count and rarity columns do not create extra entries. `tokenid` / `token_id`
(one token per row) are also recognized, with token columns taking precedence
over generic ID columns. Token IDs remain strings, preserving leading zeros and
large integers. Duplicate IDs and missing token values are rejected. The offline
verifier accepts the same snapshot format.
