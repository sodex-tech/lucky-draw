#!/usr/bin/env node
// Independent replay tool: given the published public seed, reproduces the
// full four-tier draw result so anyone can audit the winners offline.
//
// Usage:
//   node verify.mjs <public-seed> [path/to/ticket-map.csv]
//
// Output: the same rows the app exports (draw order, prize level, ticket
// number) printed as CSV, plus the dataset SHA-256 for cross-checking.

import { readFile } from "node:fs/promises";
import {
  PRIZE_TIERS,
  drawPrizeTier,
  parseTicketCsv,
  validateTicketDataset,
} from "./draw-engine.mjs";

const [, , publicSeed, ticketMapPath = new URL("./ticket-map.csv", import.meta.url).pathname] = process.argv;

if (!publicSeed || publicSeed.trim() === "") {
  console.error("Usage: node verify.mjs <public-seed> [path/to/ticket-map.csv]");
  process.exit(1);
}

const source = await readFile(ticketMapPath, "utf8");
const dataset = await validateTicketDataset(parseTicketCsv(source));

console.error(`tickets: ${dataset.tickets.length}`);
console.error(`dataset_sha256: ${dataset.datasetHash}`);
console.error(`public_seed: ${publicSeed.trim()}`);
console.error("");

const winners = [];
for (const tier of PRIZE_TIERS) {
  const tierWinners = await drawPrizeTier({
    tickets: dataset.tickets,
    tier,
    previousWinners: winners,
    publicSeed,
  });
  winners.push(...tierWinners);
}

console.log("draw_order,prize_level,ticket_number");
winners.forEach((winner, index) => {
  console.log(`${index + 1},${winner.prizeLevel},${winner.ticketNumber}`);
});
