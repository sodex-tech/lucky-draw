# Public Ticket Draw

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

## Draw mechanism

1. `ticket-map.csv` is parsed and validated before drawing. Ticket numbers must be contiguous from `00001` to `27283`.
2. A public seed is entered before drawing. Using a public, unpredictable value (for example, the hash of a recent on-chain transaction) is recommended so the seed cannot be pre-computed. The seed is locked once the first round starts, so the same seed drives all four tiers.
3. Prize tiers are drawn in this order: 4th Prize (400), 3rd Prize (90), 2nd Prize (9), then 1st Prize (1).
4. Winner selection is fully deterministic: `SHA-256(public seed + ":" + tier key)` seeds an sfc32-style PRNG (see `createSeededRandom` in `draw-engine.mjs` for the exact variant), and each winning ticket is removed from the pool immediately. The same dataset and seed always reproduce the same 500 winners.
5. Every confirmed ticket is removed from subsequent tiers, so one ticket cannot win twice.
6. Each tier can be copied with its title and winning ticket numbers, and the complete result can be exported as CSV.
7. The exported CSV contains draw order, prize level, ticket number, **the public seed**, dataset hash, and the UTC confirmation time of each round — everything needed to replay the draw.

## Verify a draw independently

Anyone can reproduce the full result offline with Node 20+:

```bash
node verify.mjs <public-seed>
```

It prints the dataset SHA-256 and all 500 winning tickets in draw order. Compare them against the exported CSV: the seed, the dataset hash, and every ticket number must match.

## Key files

- `draw-engine.mjs`: validation, winner selection, and CSV export.
- `verify.mjs`: standalone replay tool for auditing a draw result.
- `ticket-map.csv`: the list of valid ticket numbers.
- `variants/c/app.mjs`: session state, countdown, sound, copy, reset, and UI orchestration.
- `variants/c/styles.css`: virtualized 2D ticket wall and responsive layout.
