#!/usr/bin/env node
// Independent replay tool: given the published public seed, the exported draw
// config and the ticket list, reproduces every winner so anyone can audit the
// result offline.
//
// Usage:
//   node verify.mjs <public-seed> <config.json> <tickets.csv>
//
// Output: the same rows the app exports (draw order, round, prize, ticket
// number, holder) printed as CSV, plus the dataset SHA-256 for cross-checking.

import { readFile } from "node:fs/promises";
import {
  countConfiguredSlots,
  drawRound,
  normalizeConfig,
  parseTicketSource,
  validateConfig,
  validateTicketDataset,
} from "./draw-engine.mjs";

const [, , publicSeed, configPath, ticketPath] = process.argv;

if (!publicSeed || publicSeed.trim() === "" || !configPath || !ticketPath) {
  console.error("Usage: node verify.mjs <public-seed> <config.json> <tickets.csv>");
  process.exit(1);
}

const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
const dataset = await validateTicketDataset(parseTicketSource(await readFile(ticketPath, "utf8")));

const issues = validateConfig(config, dataset.tickets.length);
if (issues.length > 0) {
  console.error("Invalid draw config:");
  issues.forEach((issue) => console.error(`  - ${issue}`));
  process.exit(1);
}

console.error(`title: ${config.title}`);
console.error(`tickets: ${dataset.tickets.length}`);
console.error(`dataset_sha256: ${dataset.datasetHash}`);
console.error(`public_seed: ${publicSeed.trim()}`);
console.error(`rounds: ${config.rounds.length}`);
console.error(`winners: ${countConfiguredSlots(config)}`);
console.error("");

const winners = [];
for (const round of config.rounds) {
  const roundWinners = await drawRound({
    tickets: dataset.tickets,
    round,
    prizes: config.prizes,
    previousWinners: winners,
    publicSeed,
  });
  winners.push(...roundWinners);
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

console.log("draw_order,round,prize,ticket_number,holder");
winners.forEach((winner, index) => {
  console.log(
    [index + 1, winner.roundName, winner.prizeName, winner.ticketNumber, winner.holder]
      .map(escapeCsvCell)
      .join(","),
  );
});
