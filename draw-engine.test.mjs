import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResultsCsv,
  countConfiguredSlots,
  createDefaultConfig,
  createPrize,
  createRound,
  drawRound,
  isImageIcon,
  normalizeConfig,
  normalizeTicketValue,
  parseTicketSource,
  sanitizeIcon,
  validateConfig,
  validateTicketDataset,
} from "./draw-engine.mjs";

function makeTickets(count) {
  return Array.from({ length: count }, (_, index) => ({
    ticketNumber: String(index + 1).padStart(5, "0"),
    holder: "",
  }));
}

test("keeps ticket values verbatim instead of forcing a numeric format", () => {
  assert.equal(normalizeTicketValue(" 01234 "), "01234");
  assert.equal(normalizeTicketValue("A-77"), "A-77");
  assert.throws(() => normalizeTicketValue("   "), /empty/);
});

test("parses a CSV with a header, a ticket column and an optional name column", () => {
  const tickets = parseTicketSource(
    ["ticket_number,name", "1,Alice", '2,"Bui, Minh"', "3,"].join("\n"),
  );
  assert.deepEqual(tickets, [
    { ticketNumber: "1", holder: "Alice" },
    { ticketNumber: "2", holder: "Bui, Minh" },
    { ticketNumber: "3", holder: "" },
  ]);
});

test("parses a pasted list with no header, with or without names", () => {
  assert.deepEqual(parseTicketSource("00001\n00002\n00003").map((t) => t.ticketNumber), [
    "00001",
    "00002",
    "00003",
  ]);
  assert.deepEqual(parseTicketSource("00001,Alice\n00002,Bob"), [
    { ticketNumber: "00001", holder: "Alice" },
    { ticketNumber: "00002", holder: "Bob" },
  ]);
  assert.deepEqual(parseTicketSource("7,8,9").map((t) => t.ticketNumber), ["7", "8", "9"]);
});

test("sorts tickets canonically and rejects duplicates", async () => {
  const dataset = await validateTicketDataset([
    { ticketNumber: "10" },
    { ticketNumber: "00002" },
    { ticketNumber: "A-1" },
    { ticketNumber: "9" },
  ]);
  assert.deepEqual(
    dataset.tickets.map((ticket) => ticket.ticketNumber),
    ["00002", "9", "10", "A-1"],
  );
  assert.equal(dataset.datasetHash.length, 64);

  await assert.rejects(
    validateTicketDataset([{ ticketNumber: "1" }, { ticketNumber: "1" }]),
    /duplicate ticket number/i,
  );
  await assert.rejects(validateTicketDataset([]), /at least one ticket/i);
});

test("the dataset hash commits to holder names, not just ticket numbers", async () => {
  const withoutHolder = await validateTicketDataset([{ ticketNumber: "1", holder: "" }]);
  const withHolder = await validateTicketDataset([{ ticketNumber: "1", holder: "Alice" }]);
  assert.notEqual(withoutHolder.datasetHash, withHolder.datasetHash);
});

test("normalizes an imported config and drops items pointing at a missing prize", () => {
  const prize = createPrize({ name: "Cap" });
  const config = normalizeConfig({
    title: "   Season finale   ",
    prizes: [prize],
    rounds: [
      { name: "", items: [{ prizeId: prize.id, count: "3" }, { prizeId: "gone", count: 5 }] },
      { name: "Round two", items: [{ prizeId: prize.id, count: -4 }] },
    ],
  });

  assert.equal(config.title, "Season finale");
  assert.equal(config.rounds[0].name, "Round 1");
  assert.deepEqual(config.rounds[0].items, [{ prizeId: prize.id, count: 3 }]);
  assert.equal(config.rounds[1].items[0].count, 1);
  assert.equal(countConfiguredSlots(config), 4);
});

test("sanitizes prize icons and recognizes image icons", () => {
  assert.equal(sanitizeIcon("  🏆  "), "🏆");
  assert.equal(sanitizeIcon(""), "🎁");
  assert.equal(sanitizeIcon("javascript:alert(1)"), "java");
  assert.equal(sanitizeIcon("https://example.com/cup.png"), "https://example.com/cup.png");
  assert.equal(isImageIcon("data:image/webp;base64,AAAA"), true);
  assert.equal(isImageIcon("🏆"), false);
});

test("reports setup problems, including drawing more winners than tickets", () => {
  assert.deepEqual(validateConfig(normalizeConfig({}), 10), [
    "Add at least one prize.",
    "Add at least one round.",
  ]);

  const config = createDefaultConfig();
  assert.deepEqual(validateConfig(config, 5_000), []);
  assert.match(validateConfig(config, 4)[0], /only 4 tickets are imported/);

  const emptyRound = normalizeConfig({
    prizes: [createPrize()],
    rounds: [createRound({ name: "Empty", items: [] })],
  });
  assert.match(validateConfig(emptyRound, 100)[0], /has no prize to draw/);
});

test("draws every prize in a round, reproduces the same result, and never repeats a ticket", async () => {
  const dataset = await validateTicketDataset(makeTickets(40));
  const cap = createPrize({ name: "Cap" });
  const jacket = createPrize({ name: "Jacket" });
  const roundOne = createRound({
    name: "Round 1",
    items: [
      { prizeId: cap.id, count: 6 },
      { prizeId: jacket.id, count: 2 },
    ],
  });
  const roundTwo = createRound({ name: "Round 2", items: [{ prizeId: jacket.id, count: 3 }] });
  const prizes = [cap, jacket];

  const firstRun = await drawRound({
    tickets: dataset.tickets,
    round: roundOne,
    prizes,
    previousWinners: [],
    publicSeed: "block-hash-0xabc",
  });
  const replay = await drawRound({
    tickets: dataset.tickets,
    round: roundOne,
    prizes,
    previousWinners: [],
    publicSeed: "block-hash-0xabc",
  });
  const second = await drawRound({
    tickets: dataset.tickets,
    round: roundTwo,
    prizes,
    previousWinners: firstRun,
    publicSeed: "block-hash-0xabc",
  });

  assert.deepEqual(replay, firstRun);
  assert.equal(firstRun.length, 8);
  assert.equal(firstRun.filter((winner) => winner.prizeId === cap.id).length, 6);
  assert.equal(firstRun.filter((winner) => winner.prizeId === jacket.id).length, 2);
  assert.equal(new Set(firstRun.map((winner) => winner.ticketNumber)).size, 8);
  assert.equal(
    second.some((winner) =>
      firstRun.some((previous) => previous.ticketNumber === winner.ticketNumber),
    ),
    false,
  );
  assert.equal(firstRun[0].roundName, "Round 1");
  assert.equal("prizeIcon" in firstRun[0], false);
});

test("the same prize drawn twice in one round does not repeat the first batch", async () => {
  const dataset = await validateTicketDataset(makeTickets(30));
  const prize = createPrize({ name: "Sticker" });
  const round = createRound({
    items: [
      { prizeId: prize.id, count: 4 },
      { prizeId: prize.id, count: 4 },
    ],
  });
  const winners = await drawRound({
    tickets: dataset.tickets,
    round,
    prizes: [prize],
    previousWinners: [],
    publicSeed: "seed",
  });
  assert.equal(new Set(winners.map((winner) => winner.ticketNumber)).size, 8);
});

test("a different public seed produces a different result", async () => {
  const dataset = await validateTicketDataset(makeTickets(200));
  const prize = createPrize();
  const round = createRound({ items: [{ prizeId: prize.id, count: 10 }] });
  const draw = (publicSeed) =>
    drawRound({ tickets: dataset.tickets, round, prizes: [prize], previousWinners: [], publicSeed });

  const first = await draw("seed-a");
  const second = await draw("seed-b");
  assert.notDeepEqual(
    first.map((winner) => winner.ticketNumber),
    second.map((winner) => winner.ticketNumber),
  );
});

test("requires a public seed and enough remaining tickets", async () => {
  const prize = createPrize();
  const round = createRound({ items: [{ prizeId: prize.id, count: 2 }] });
  await assert.rejects(
    drawRound({
      tickets: makeTickets(5),
      round,
      prizes: [prize],
      previousWinners: [],
      publicSeed: "   ",
    }),
    /public seed is required/,
  );
  await assert.rejects(
    drawRound({
      tickets: makeTickets(1),
      round,
      prizes: [prize],
      previousWinners: [],
      publicSeed: "seed",
    }),
    /Not enough tickets remaining/,
  );
  await assert.rejects(
    drawRound({
      tickets: makeTickets(5),
      round: createRound({ items: [] }),
      prizes: [prize],
      previousWinners: [],
      publicSeed: "seed",
    }),
    /no prize to draw/,
  );
});

test("exports audit metadata, the public seed, and per-round timestamps", () => {
  const csv = buildResultsCsv({
    winners: [
      {
        roundName: "Round 1",
        prizeName: "Cap",
        ticketNumber: "01234",
        holder: "Bui, Minh",
        drawnAt: "2026-07-14T09:55:00.000Z",
      },
      {
        roundName: "Round 2",
        prizeName: "Grand Prize",
        ticketNumber: "00777",
        holder: "",
      },
    ],
    datasetHash: "abc123",
    publicSeed: "block-hash-0xabc",
    drawnAt: "2026-07-14T10:00:00.000Z",
  });

  const [header, firstRow, secondRow] = csv.split("\n");
  assert.equal(
    header,
    "draw_order,round,prize,ticket_number,holder,public_seed,dataset_sha256,drawn_at_utc",
  );
  assert.equal(
    firstRow,
    '1,Round 1,Cap,01234,"Bui, Minh",block-hash-0xabc,abc123,2026-07-14T09:55:00.000Z',
  );
  assert.equal(
    secondRow,
    "2,Round 2,Grand Prize,00777,,block-hash-0xabc,abc123,2026-07-14T10:00:00.000Z",
  );
});


test("expands snapshot token_ids and keeps the owning wallet, ignoring counts", async () => {
  const source = "wallet,tickets,boxes,common,uncommon,rare,superrare,token_ids\n0xAlice,3,3,2,1,0,0,001 42 9007199254740993\n0xBob,1,1,1,0,0,0,99";
  const parsed = parseTicketSource(source);
  assert.deepEqual(parsed, [
    { ticketNumber: "001", holder: "0xAlice" },
    { ticketNumber: "42", holder: "0xAlice" },
    { ticketNumber: "9007199254740993", holder: "0xAlice" },
    { ticketNumber: "99", holder: "0xBob" },
  ]);
  assert.equal((await validateTicketDataset(parsed)).tickets.length, 4);
});

test("recognizes token ID aliases and prioritizes them over other ID columns", () => {
  assert.deepEqual(parseTicketSource("id,Token ID,wallet\nrow1,0007,0xAlice"), [
    { ticketNumber: "0007", holder: "0xAlice" },
  ]);
  assert.deepEqual(parseTicketSource('wallet,Token IDs\n0xAlice,"7  8\n9"'), [
    { ticketNumber: "7", holder: "0xAlice" },
    { ticketNumber: "8", holder: "0xAlice" },
    { ticketNumber: "9", holder: "0xAlice" },
  ]);
});

test("rejects duplicate snapshot tokens and rows without token IDs", async () => {
  await assert.rejects(validateTicketDataset(parseTicketSource(
    "wallet,token_ids\n0xAlice,7 8\n0xBob,8 9",
  )), /duplicate ticket number/i);
  assert.throws(() => parseTicketSource("wallet,tickets,token_ids\n0xAlice,2,"), /Row 2 has no ticket value/);
});
