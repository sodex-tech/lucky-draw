export const CONFIG_VERSION = 1;
export const MAX_TICKETS = 500_000;

const TICKET_HEADER_KEYS = [
  "ticketnumber",
  "ticketno",
  "ticketid",
  "ticket",
  "luckydrawticketnumber",
  "entry",
  "entryid",
  "serial",
  "number",
  "no",
  "id",
  "code",
];

const HOLDER_HEADER_KEYS = [
  "holder",
  "name",
  "fullname",
  "displayname",
  "owner",
  "user",
  "username",
  "nickname",
  "handle",
  "participant",
  "member",
];

function randomHex(byteLength) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function createId(prefix) {
  return `${prefix}_${randomHex(6)}`;
}

export function createPrize(overrides = {}) {
  return {
    id: createId("prize"),
    icon: "🎁",
    name: "Prize",
    description: "",
    ...overrides,
  };
}

export function createRound(overrides = {}) {
  return {
    id: createId("round"),
    name: "Round",
    items: [],
    ...overrides,
  };
}

export function createDefaultConfig() {
  const grandPrize = createPrize({
    icon: "🏆",
    name: "Grand Prize",
    description: "The headline prize of the draw",
  });
  const runnerUp = createPrize({
    icon: "🎖️",
    name: "Runner-up",
    description: "Second-tier prize",
  });
  const giveaway = createPrize({
    icon: "🎁",
    name: "Giveaway",
    description: "Everyone loves a giveaway",
  });

  return {
    version: CONFIG_VERSION,
    title: "Lucky Draw",
    prizes: [grandPrize, runnerUp, giveaway],
    rounds: [
      createRound({
        name: "Round 1 · Giveaway",
        items: [{ prizeId: giveaway.id, count: 20 }],
      }),
      createRound({
        name: "Round 2 · Runner-up",
        items: [{ prizeId: runnerUp.id, count: 5 }],
      }),
      createRound({
        name: "Round 3 · Grand Prize",
        items: [{ prizeId: grandPrize.id, count: 1 }],
      }),
    ],
  };
}

export function sanitizeIcon(value) {
  const text = String(value ?? "").trim();
  if (text === "") return "🎁";
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml);/i.test(text)) return text;
  if (/^https?:\/\//i.test(text)) return text;
  return [...text].slice(0, 4).join("");
}

export function isImageIcon(icon) {
  return /^(data:image\/|https?:\/\/)/i.test(String(icon ?? ""));
}

function clampText(value, maxLength, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? fallback : text.slice(0, maxLength);
}

export function normalizeConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const prizes = (Array.isArray(source.prizes) ? source.prizes : [])
    .filter((prize) => prize && typeof prize === "object")
    .map((prize, index) =>
      createPrize({
        id: typeof prize.id === "string" && prize.id.trim() !== "" ? prize.id.trim().slice(0, 64) : undefined,
        icon: sanitizeIcon(prize.icon),
        name: clampText(prize.name, 60, `Prize ${index + 1}`),
        description: clampText(prize.description, 160),
      }),
    );

  const seenPrizeIds = new Set();
  prizes.forEach((prize) => {
    while (seenPrizeIds.has(prize.id)) prize.id = createId("prize");
    seenPrizeIds.add(prize.id);
  });

  const prizeIds = new Set(prizes.map((prize) => prize.id));
  const rounds = (Array.isArray(source.rounds) ? source.rounds : [])
    .filter((round) => round && typeof round === "object")
    .map((round, index) =>
      createRound({
        id: typeof round.id === "string" && round.id.trim() !== "" ? round.id.trim().slice(0, 64) : undefined,
        name: clampText(round.name, 60, `Round ${index + 1}`),
        items: (Array.isArray(round.items) ? round.items : [])
          .filter((item) => item && typeof item === "object" && prizeIds.has(item.prizeId))
          .map((item) => ({
            prizeId: item.prizeId,
            count: Math.min(MAX_TICKETS, Math.max(1, Math.floor(Number(item.count)) || 1)),
          })),
      }),
    );

  const seenRoundIds = new Set();
  rounds.forEach((round) => {
    while (seenRoundIds.has(round.id)) round.id = createId("round");
    seenRoundIds.add(round.id);
  });

  return {
    version: CONFIG_VERSION,
    title: clampText(source.title, 80, "Lucky Draw"),
    prizes,
    rounds,
  };
}

export function countRoundSlots(round) {
  return round.items.reduce((total, item) => total + item.count, 0);
}

export function countConfiguredSlots(config) {
  return config.rounds.reduce((total, round) => total + countRoundSlots(round), 0);
}

export function validateConfig(config, ticketCount = Infinity) {
  const issues = [];
  if (config.prizes.length === 0) issues.push("Add at least one prize.");
  if (config.rounds.length === 0) issues.push("Add at least one round.");
  config.rounds.forEach((round, index) => {
    if (round.items.length === 0) {
      issues.push(`Round ${index + 1} ("${round.name}") has no prize to draw.`);
    }
  });
  const totalSlots = countConfiguredSlots(config);
  if (totalSlots > ticketCount) {
    issues.push(
      `The rounds draw ${totalSlots.toLocaleString()} winners but only ${ticketCount.toLocaleString()} tickets are imported.`,
    );
  }
  return issues;
}

export function normalizeTicketValue(value) {
  // Whitespace is collapsed so a ticket value can never contain a tab or a
  // newline, which the browser app uses as separators when it caches tickets.
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  if (trimmed === "") throw new Error("Ticket value is empty");
  return trimmed.slice(0, 64);
}

function parseCsvMatrix(source) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (char === '"' && quoted && nextChar === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if ((char === "," || char === "\t" || char === ";") && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && nextChar === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  if (quoted) throw new Error("CSV contains an unclosed quoted field");
  return rows;
}

function normalizeHeader(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Accepts a CSV/TSV export or a plain pasted list. The ticket column is
 * detected from the header when one is present; an optional holder column is
 * used to show a name next to each winning ticket.
 */
export function parseTicketSource(source) {
  const matrix = parseCsvMatrix(String(source ?? "").trim());
  if (matrix.length === 0) throw new Error("No tickets found");

  const headers = matrix[0].map(normalizeHeader);
  const headerTicketIndex = headers.findIndex((header) => TICKET_HEADER_KEYS.includes(header));
  const headerHolderIndex = headers.findIndex((header) => HOLDER_HEADER_KEYS.includes(header));
  const hasHeader = headerTicketIndex >= 0 || headerHolderIndex >= 0;
  const dataRows = hasHeader ? matrix.slice(1) : matrix;
  const columnCount = Math.max(...matrix.map((row) => row.length));

  // A single pasted line such as "1,2,3" is a list of tickets, not one record.
  if (!hasHeader && matrix.length === 1 && columnCount > 2) {
    return matrix[0]
      .map((value) => value.trim())
      .filter((value) => value !== "")
      .map((value) => ({ ticketNumber: normalizeTicketValue(value), holder: "" }));
  }

  let ticketColumn = headerTicketIndex;
  if (ticketColumn < 0) ticketColumn = headerHolderIndex === 0 && columnCount > 1 ? 1 : 0;
  let holderColumn = headerHolderIndex;
  if (holderColumn < 0 && !hasHeader && columnCount > 1) holderColumn = ticketColumn === 0 ? 1 : 0;
  if (holderColumn === ticketColumn) holderColumn = -1;

  const tickets = [];
  dataRows.forEach((row, index) => {
    const rawTicket = row[ticketColumn];
    if (rawTicket === undefined || rawTicket.trim() === "") {
      if (row.every((value) => value.trim() === "")) return;
      throw new Error(`Row ${index + (hasHeader ? 2 : 1)} has no ticket value`);
    }
    tickets.push({
      ticketNumber: normalizeTicketValue(rawTicket),
      holder: holderColumn >= 0 ? clampText(row[holderColumn], 60) : "",
    });
  });

  if (tickets.length === 0) throw new Error("No tickets found");
  return tickets;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Canonical ticket order, so the same ticket set always produces the same
 * winners no matter how the source file happened to be sorted.
 */
export function compareTickets(left, right) {
  const leftValue = left.ticketNumber;
  const rightValue = right.ticketNumber;
  const leftIsNumeric = /^\d+$/.test(leftValue);
  const rightIsNumeric = /^\d+$/.test(rightValue);
  if (leftIsNumeric && rightIsNumeric) {
    const leftDigits = leftValue.replace(/^0+(?=\d)/, "");
    const rightDigits = rightValue.replace(/^0+(?=\d)/, "");
    if (leftDigits.length !== rightDigits.length) return leftDigits.length - rightDigits.length;
    if (leftDigits !== rightDigits) return leftDigits < rightDigits ? -1 : 1;
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  if (leftIsNumeric !== rightIsNumeric) return leftIsNumeric ? -1 : 1;
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export async function validateTicketDataset(tickets) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error("Import at least one ticket");
  }
  if (tickets.length > MAX_TICKETS) {
    throw new Error(`At most ${MAX_TICKETS.toLocaleString()} tickets are supported`);
  }

  const sortedTickets = [...tickets].sort(compareTickets);
  const seen = new Set();
  const duplicates = [];
  sortedTickets.forEach((ticket) => {
    if (seen.has(ticket.ticketNumber)) duplicates.push(ticket.ticketNumber);
    seen.add(ticket.ticketNumber);
  });
  if (duplicates.length > 0) {
    throw new Error(
      `${duplicates.length.toLocaleString()} duplicate ticket number${duplicates.length === 1 ? "" : "s"} found, starting with "${duplicates[0]}"`,
    );
  }

  const canonicalDataset = sortedTickets
    .map((ticket) => `${ticket.ticketNumber}\t${ticket.holder ?? ""}`)
    .join("\n");

  return {
    tickets: sortedTickets,
    datasetHash: toHex(await sha256(canonicalDataset)),
  };
}

export function createRandomSeed() {
  return randomHex(16);
}

async function createSeededRandom(seed) {
  const bytes = await sha256(seed);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let a = view.getUint32(0, true);
  let b = view.getUint32(4, true);
  let c = view.getUint32(8, true);
  let d = view.getUint32(12, true);

  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const result = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = ((c << 21) | (c >>> 11)) | 0;
    c = (c + result) | 0;
    return (result >>> 0) / 4294967296;
  };
}

export async function drawRound({ tickets, round, prizes, previousWinners, publicSeed }) {
  if (String(publicSeed ?? "").trim() === "") {
    throw new Error("A public seed is required");
  }
  if (!round || round.items.length === 0) {
    throw new Error("This round has no prize to draw");
  }

  const prizeById = new Map(prizes.map((prize) => [prize.id, prize]));
  const usedTicketNumbers = new Set(previousWinners.map((winner) => winner.ticketNumber));
  const pool = tickets.filter((ticket) => !usedTicketNumbers.has(ticket.ticketNumber));
  const requiredSlots = countRoundSlots(round);
  if (pool.length < requiredSlots) {
    throw new Error(
      `Not enough tickets remaining for ${round.name}: ${requiredSlots.toLocaleString()} needed, ${pool.length.toLocaleString()} left`,
    );
  }

  const winners = [];
  for (const [itemIndex, item] of round.items.entries()) {
    const prize = prizeById.get(item.prizeId);
    if (!prize) throw new Error(`Round "${round.name}" references a prize that no longer exists`);
    const random = await createSeededRandom(
      `${publicSeed.trim()}:${round.id}:${prize.id}:${itemIndex}`,
    );
    for (let index = 0; index < item.count; index += 1) {
      const selectedIndex = Math.floor(random() * pool.length);
      const [ticket] = pool.splice(selectedIndex, 1);
      if (!ticket) throw new Error("Unable to select a winning ticket");
      // The icon is deliberately left out: it can be a large data URL and the
      // winner list is persisted on every round.
      winners.push({
        roundId: round.id,
        roundName: round.name,
        prizeId: prize.id,
        prizeName: prize.name,
        ticketNumber: ticket.ticketNumber,
        holder: ticket.holder ?? "",
      });
    }
  }
  return winners;
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildResultsCsv({ winners, datasetHash, publicSeed, drawnAt }) {
  const headers = [
    "draw_order",
    "round",
    "prize",
    "ticket_number",
    "holder",
    "public_seed",
    "dataset_sha256",
    "drawn_at_utc",
  ];
  const rows = winners.map((winner, index) => [
    index + 1,
    winner.roundName,
    winner.prizeName,
    winner.ticketNumber,
    winner.holder ?? "",
    publicSeed,
    datasetHash,
    winner.drawnAt ?? drawnAt,
  ]);
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n");
}
