export const TOTAL_TICKET_COUNT = 27283;

export const PRIZE_TIERS = [
  {
    key: "fourth",
    label: "4th Prize",
    slots: 400,
    selectionMethod: "random",
  },
  {
    key: "third",
    label: "3rd Prize",
    slots: 90,
    selectionMethod: "random",
  },
  {
    key: "second",
    label: "2nd Prize",
    slots: 9,
    selectionMethod: "random",
  },
  {
    key: "first",
    label: "1st Prize",
    slots: 1,
    selectionMethod: "random",
  },
];

export function normalizeTicketNumber(value) {
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ticket number: ${trimmed || "(empty)"}`);
  }
  const numericValue = Number(trimmed);
  if (!Number.isSafeInteger(numericValue) || numericValue < 1) {
    throw new Error(`Invalid ticket number: ${trimmed}`);
  }
  return String(numericValue).padStart(5, "0");
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
    } else if (char === "," && !quoted) {
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
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function parseTicketCsv(source) {
  const matrix = parseCsvMatrix(source.trim());
  const [headerRow, ...dataRows] = matrix;
  if (!headerRow) throw new Error("CSV is empty");

  const headers = headerRow.map(normalizeHeader);
  const ticketIndex = headers.findIndex((header) =>
    ["ticketnumber", "luckydrawticketnumber"].includes(header),
  );
  if (ticketIndex < 0) {
    throw new Error("CSV must contain a ticket_number column");
  }

  return dataRows.map((row) => ({
    ticketNumber: normalizeTicketNumber(row[ticketIndex] ?? ""),
  }));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function validateTicketDataset(
  tickets,
  expectedTotal = TOTAL_TICKET_COUNT,
) {
  if (tickets.length !== expectedTotal) {
    throw new Error(
      `Expected ${expectedTotal.toLocaleString()} tickets, received ${tickets.length.toLocaleString()}`,
    );
  }

  const sortedTickets = [...tickets].sort(
    (left, right) => Number(left.ticketNumber) - Number(right.ticketNumber),
  );
  sortedTickets.forEach((ticket, index) => {
    const expectedTicketNumber = String(index + 1).padStart(5, "0");
    if (ticket.ticketNumber !== expectedTicketNumber) {
      throw new Error(
        `Ticket sequence mismatch: expected ${expectedTicketNumber}, received ${ticket.ticketNumber}`,
      );
    }
  });

  const canonicalDataset = sortedTickets
    .map((ticket) => ticket.ticketNumber)
    .join("\n");
  const datasetHash = toHex(await sha256(canonicalDataset));

  return {
    tickets: sortedTickets,
    datasetHash,
  };
}

export function createRandomSeed() {
  return toHex(crypto.getRandomValues(new Uint8Array(16)));
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

export async function drawPrizeTier({ tickets, tier, previousWinners, publicSeed }) {
  if (String(publicSeed ?? "").trim() === "") {
    throw new Error("A public seed is required");
  }

  const usedTicketNumbers = new Set(
    previousWinners.map((winner) => winner.ticketNumber),
  );
  const availableTickets = tickets.filter(
    (ticket) => !usedTicketNumbers.has(ticket.ticketNumber),
  );
  if (availableTickets.length < tier.slots) {
    throw new Error(`Not enough tickets remaining for ${tier.label}`);
  }

  const random = await createSeededRandom(`${publicSeed.trim()}:${tier.key}`);
  const winners = [];
  for (let index = 0; index < tier.slots; index += 1) {
    const selectedIndex = Math.floor(random() * availableTickets.length);
    const [ticket] = availableTickets.splice(selectedIndex, 1);
    if (!ticket) throw new Error("Unable to select a winning ticket");
    winners.push({
      prizeLevel: tier.label,
      ticketNumber: ticket.ticketNumber,
      selectionMethod: "random",
    });
  }
  return winners;
}

function escapeCsvCell(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function buildResultsCsv({
  winners,
  datasetHash,
  publicSeed,
  drawnAt,
}) {
  const headers = [
    "draw_order",
    "prize_level",
    "ticket_number",
    "public_seed",
    "dataset_sha256",
    "drawn_at_utc",
  ];
  const rows = winners.map((winner, index) => [
    index + 1,
    winner.prizeLevel,
    winner.ticketNumber,
    publicSeed,
    datasetHash,
    winner.drawnAt ?? drawnAt,
  ]);
  return [headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\n");
}
