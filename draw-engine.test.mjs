import assert from "node:assert/strict";
import test from "node:test";
import {
  PRIZE_TIERS,
  buildResultsCsv,
  drawPrizeTier,
  normalizeTicketNumber,
  parseTicketCsv,
  validateTicketDataset,
} from "./draw-engine.mjs";

test("normalizes ticket numbers without losing the five-digit display format", () => {
  assert.equal(normalizeTicketNumber("1234"), "01234");
  assert.equal(normalizeTicketNumber("01234"), "01234");
});

test("parses quoted CSV rows and validates a contiguous ticket dataset", async () => {
  const csv = [
    "ticket_number,note",
    "1,",
    '2,"hello, world"',
    "3,",
  ].join("\n");
  const tickets = parseTicketCsv(csv);
  const dataset = await validateTicketDataset(tickets, 3);

  assert.equal(dataset.tickets[0].ticketNumber, "00001");
  assert.equal(dataset.datasetHash.length, 64);
});

test("uses the public seed for every tier, reproduces the same result, and never repeats a ticket", async () => {
  const tickets = Array.from({ length: 20 }, (_, index) => ({
    ticketNumber: String(index + 1).padStart(5, "0"),
  }));
  const dataset = await validateTicketDataset(tickets, 20);
  const firstTier = {
    key: "test",
    label: "Test Prize",
    slots: 10,
    selectionMethod: "random",
  };
  const firstRun = await drawPrizeTier({
    tickets: dataset.tickets,
    tier: firstTier,
    previousWinners: [],
    publicSeed: "discord-message-123",
  });
  const replay = await drawPrizeTier({
    tickets: dataset.tickets,
    tier: firstTier,
    previousWinners: [],
    publicSeed: "discord-message-123",
  });
  const nextTier = await drawPrizeTier({
    tickets: dataset.tickets,
    tier: { ...firstTier, key: "next", slots: 5 },
    previousWinners: firstRun,
    publicSeed: "discord-message-123",
  });

  assert.deepEqual(replay, firstRun);
  assert.equal(firstRun.length, 10);
  assert.equal(new Set(firstRun.map((winner) => winner.ticketNumber)).size, 10);
  assert.equal(
    nextTier.some((winner) =>
      firstRun.some((previous) => previous.ticketNumber === winner.ticketNumber),
    ),
    false,
  );
  assert.equal(PRIZE_TIERS.every((tier) => tier.selectionMethod === "random"), true);
});

test("requires a public seed", async () => {
  await assert.rejects(
    drawPrizeTier({
      tickets: [{ ticketNumber: "00001" }],
      tier: { key: "first", label: "1st Prize", slots: 1 },
      previousWinners: [],
      publicSeed: "   ",
    }),
    /public seed is required/,
  );
});

test("rejects a draw when fewer tickets remain than the tier requires", async () => {
  await assert.rejects(
    drawPrizeTier({
      tickets: [{ ticketNumber: "00001" }],
      tier: { key: "first", label: "1st Prize", slots: 2 },
      previousWinners: [],
      publicSeed: "discord-message-123",
    }),
    /Not enough tickets remaining/,
  );
});

test("exports audit metadata, the public seed, and per-round timestamps", () => {
  const csv = buildResultsCsv({
    winners: [
      {
        prizeLevel: "4th Prize",
        ticketNumber: "01234",
        selectionMethod: "random",
        drawnAt: "2026-07-14T09:55:00.000Z",
      },
      {
        prizeLevel: "1st Prize",
        ticketNumber: "00777",
        selectionMethod: "random",
      },
    ],
    datasetHash: "abc123",
    publicSeed: "discord-message-123",
    drawnAt: "2026-07-14T10:00:00.000Z",
  });

  const [header, firstRow, secondRow] = csv.split("\n");
  assert.equal(
    header,
    "draw_order,prize_level,ticket_number,public_seed,dataset_sha256,drawn_at_utc",
  );
  assert.equal(firstRow, "1,4th Prize,01234,discord-message-123,abc123,2026-07-14T09:55:00.000Z");
  assert.equal(secondRow, "2,1st Prize,00777,discord-message-123,abc123,2026-07-14T10:00:00.000Z");
  assert.doesNotMatch(csv, /address/);
});
