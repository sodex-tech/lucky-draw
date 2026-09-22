import { applySodexPreset, SODEX_BOXES } from "../../sodex-preset.mjs";
import {
  buildResultsCsv,
  countConfiguredSlots,
  countRoundSlots,
  createDefaultConfig,
  createPrize,
  createRandomSeed,
  createRound,
  drawRound,
  isImageIcon,
  normalizeConfig,
  parseTicketSource,
  sanitizeIcon,
  validateConfig,
  validateTicketDataset,
} from "../../draw-engine.mjs";

const DRAW_DURATION_MS = 10_000;
const CONFIG_KEY = "lucky-draw-setup-v1";
const SESSION_KEY = "lucky-draw-session-v1";
const CELEBRATE_WINNER_LIMIT = 10;
const ICON_MAX_EDGE = 192;
const ICON_MAX_FILE_BYTES = 8 * 1024 * 1024;

const state = {
  config: createDefaultConfig(),
  dataset: null,
  winners: [],
  roundIndex: 0,
  drawnAt: null,
  drawing: false,
  soundEnabled: true,
  flashingCells: new Set(),
  drawSeed: createRandomSeed(),
  seedRolling: false,
};

/** Working copy edited inside the settings dialog, applied on save. */
const draft = {
  config: null,
  dataset: null,
  ticketStatus: "",
  ticketStatusKind: "neutral",
};

const ticketElements = new Map();

const elements = {
  addPrizeButton: document.querySelector("#add-prize-button"),
  addRoundButton: document.querySelector("#add-round-button"),
  broadcastStatus: document.querySelector("#broadcast-status"),
  celebrateBadge: document.querySelector("#celebrate-badge"),
  celebrateClose: document.querySelector("#celebrate-close"),
  celebrateContinue: document.querySelector("#celebrate-continue"),
  celebrateOverlay: document.querySelector("#celebrate-overlay"),
  celebratePrizes: document.querySelector("#celebrate-prizes"),
  celebrateSubtitle: document.querySelector("#celebrate-subtitle"),
  configFile: document.querySelector("#config-file"),
  configTitle: document.querySelector("#config-title"),
  countdown: document.querySelector("#countdown"),
  countdownValue: document.querySelector("#countdown-value"),
  datasetStatus: document.querySelector("#dataset-status"),
  downloadButton: document.querySelector("#download-button"),
  drawButton: document.querySelector("#draw-button"),
  drawMessage: document.querySelector("#draw-message"),
  drawStage: document.querySelector("#draw-stage"),
  exportConfigButton: document.querySelector("#export-config-button"),
  latestRound: document.querySelector("#latest-round"),
  loadingWall: document.querySelector("#loading-wall"),
  prizeEditor: document.querySelector("#prize-editor"),
  programTitle: document.querySelector("#program-title"),
  resetButton: document.querySelector("#reset-button"),
  resultList: document.querySelector("#result-list"),
  roundEditor: document.querySelector("#round-editor"),
  roundPlan: document.querySelector("#round-plan"),
  roundProgress: document.querySelector("#round-progress"),
  roundTitle: document.querySelector("#round-title"),
  seedCopyButton: document.querySelector("#seed-copy-button"),
  seedInput: document.querySelector("#seed-input"),
  seedRandomizeButton: document.querySelector("#seed-randomize-button"),
  settingsButton: document.querySelector("#settings-button"),
  settingsCancel: document.querySelector("#settings-cancel"),
  settingsClose: document.querySelector("#settings-close"),
  settingsOverlay: document.querySelector("#settings-overlay"),
  settingsSave: document.querySelector("#settings-save"),
  settingsSummary: document.querySelector("#settings-summary"),
  soundButton: document.querySelector("#sound-button"),
  ticketApplyButton: document.querySelector("#ticket-apply-button"),
  ticketBoard: document.querySelector("#ticket-board"),
  ticketClearButton: document.querySelector("#ticket-clear-button"),
  ticketFile: document.querySelector("#ticket-file"),
  ticketGrid: document.querySelector("#ticket-grid"),
  ticketImportStatus: document.querySelector("#ticket-import-status"),
  ticketSampleButton: document.querySelector("#ticket-sample-button"),
  ticketTextarea: document.querySelector("#ticket-textarea"),
  ticketVirtualizer: document.querySelector("#ticket-virtualizer"),
  winnerCount: document.querySelector("#winner-count"),
  winnerStrip: document.querySelector("#winner-strip"),
};

let audioContext = null;
let gridFrame = null;
let gridInitialized = false;

const gridMetrics = {
  columns: 1,
  gap: 2,
  padding: 10,
  rowHeight: 21,
  totalRows: 0,
};

function wait(durationMs) {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function plural(count, singular, plural_ = `${singular}s`) {
  return count === 1 ? singular : plural_;
}

/* ------------------------------------------------------------------ sound */

function ensureAudioContext() {
  if (!state.soundEnabled) return null;
  if (!audioContext) {
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextConstructor) return null;
    audioContext = new AudioContextConstructor();
  }
  if (audioContext.state === "suspended") void audioContext.resume();
  return audioContext;
}

function playTone({ frequency, duration = 0.05, gain = 0.035, delay = 0, type = "sine" }) {
  const context = ensureAudioContext();
  if (!context) return;
  const start = context.currentTime + delay;
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume);
  volume.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playFlashTick(progress) {
  playTone({
    frequency: 640 - progress * 260,
    duration: 0.04 + progress * 0.02,
    gain: 0.012 + progress * 0.008,
    type: "sine",
  });
}

function playSecondBeat(secondsRemaining) {
  const urgent = secondsRemaining <= 3;
  playTone({
    frequency: urgent ? 480 + (3 - secondsRemaining) * 60 : 260,
    duration: urgent ? 0.1 : 0.07,
    gain: urgent ? 0.04 : 0.02,
    type: "sine",
  });
}

function playConfirmation() {
  [392, 523.25, 659.25, 783.99].forEach((frequency, index) => {
    playTone({ frequency, duration: 0.55, gain: 0.045, delay: index * 0.09, type: "triangle" });
  });
}

const countdownMusic = new Audio(new URL("./assets/countdown-bgm.mp3", import.meta.url).href);
countdownMusic.preload = "auto";
countdownMusic.volume = 0.22;

const celebrateMusic = new Audio(new URL("./assets/celebrate-bgm.mp3", import.meta.url).href);
celebrateMusic.preload = "auto";
celebrateMusic.loop = true;
celebrateMusic.volume = 0.16;

function startCountdownMusic() {
  if (!state.soundEnabled) return;
  countdownMusic.currentTime = 0;
  countdownMusic.muted = false;
  void countdownMusic.play().catch(() => {});
}

function stopCountdownMusic() {
  countdownMusic.pause();
  countdownMusic.currentTime = 0;
}

function startCelebrateMusic() {
  if (!state.soundEnabled) return;
  celebrateMusic.currentTime = 0;
  celebrateMusic.muted = false;
  void celebrateMusic.play().catch(() => {});
}

function stopCelebrateMusic() {
  celebrateMusic.pause();
  celebrateMusic.currentTime = 0;
}

/* ------------------------------------------------------------------ icons */

function renderIconInto(target, icon) {
  target.replaceChildren();
  if (isImageIcon(icon)) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = "";
    target.append(image);
    target.classList.add("has-image");
  } else {
    target.textContent = icon;
    target.classList.remove("has-image");
  }
  return target;
}

function createIconElement(icon, className = "prize-icon") {
  const figure = document.createElement("figure");
  figure.className = className;
  return renderIconInto(figure, icon);
}

async function fileToIconDataUrl(file) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
  if (file.size > ICON_MAX_FILE_BYTES) throw new Error("That image is larger than 8 MB");

  const sourceDataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Unable to read that image"));
    reader.readAsDataURL(file);
  });

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Unable to decode that image"));
    image.src = sourceDataUrl;
  });

  const naturalWidth = image.naturalWidth || ICON_MAX_EDGE;
  const naturalHeight = image.naturalHeight || ICON_MAX_EDGE;
  const scale = Math.min(1, ICON_MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  const encoded = canvas.toDataURL("image/webp", 0.85);
  return encoded.startsWith("data:image/webp") ? encoded : canvas.toDataURL("image/png");
}

/* ------------------------------------------------------- persistence */

function ticketsToLines(tickets) {
  return tickets.map((ticket) => `${ticket.ticketNumber}\t${ticket.holder ?? ""}`).join("\n");
}

function linesToTickets(lines) {
  return String(lines)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [ticketNumber, holder = ""] = line.split("\t");
      return { ticketNumber, holder };
    });
}

function persistSetup() {
  try {
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        config: state.config,
        ticketLines: state.dataset ? ticketsToLines(state.dataset.tickets) : "",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

async function restoreSetup() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null");
  } catch {
    localStorage.removeItem(CONFIG_KEY);
  }
  if (!saved || typeof saved !== "object") return false;

  state.config = normalizeConfig(saved.config);
  if (typeof saved.ticketLines === "string" && saved.ticketLines.trim() !== "") {
    try {
      state.dataset = await validateTicketDataset(linesToTickets(saved.ticketLines));
    } catch {
      state.dataset = null;
    }
  }
  return true;
}

function persistSession() {
  if (!state.dataset) return;
  try {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        datasetHash: state.dataset.datasetHash,
        roundIds: state.config.rounds.map((round) => round.id).join(","),
        winners: state.winners,
        roundIndex: state.roundIndex,
        drawnAt: state.drawnAt,
        drawSeed: state.drawSeed,
      }),
    );
  } catch {
    /* A full quota must never break the live draw. */
  }
}

function restoreSession() {
  if (!state.dataset) return;
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    const roundIds = state.config.rounds.map((round) => round.id).join(",");
    if (
      !saved ||
      saved.datasetHash !== state.dataset.datasetHash ||
      saved.roundIds !== roundIds ||
      !Array.isArray(saved.winners)
    ) {
      return;
    }
    state.winners = saved.winners;
    state.roundIndex = Number(saved.roundIndex) || 0;
    state.drawnAt = saved.drawnAt ?? null;
    if (typeof saved.drawSeed === "string" && saved.drawSeed.trim() !== "") {
      state.drawSeed = saved.drawSeed;
    }
    const latestRound = state.config.rounds[state.roundIndex - 1];
    if (latestRound) {
      renderLatestWinners(
        state.winners.filter((winner) => winner.roundId === latestRound.id),
        latestRound,
        false,
      );
    }
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
}

/* ------------------------------------------------------- ticket board */

function readGridMetrics() {
  const styles = getComputedStyle(elements.ticketBoard);
  const ticketHeight = Number.parseFloat(styles.getPropertyValue("--ticket-height")) || 19;
  const ticketMinWidth = Number.parseFloat(styles.getPropertyValue("--ticket-min-width")) || 43;
  const gap = Number.parseFloat(styles.getPropertyValue("--ticket-gap")) || 2;
  const padding = Number.parseFloat(styles.getPropertyValue("--ticket-padding")) || 10;
  const availableWidth = Math.max(1, elements.ticketBoard.clientWidth - padding * 2);

  gridMetrics.columns = Math.max(1, Math.floor((availableWidth + gap) / (ticketMinWidth + gap)));
  gridMetrics.gap = gap;
  gridMetrics.padding = padding;
  gridMetrics.rowHeight = ticketHeight + gap;
  gridMetrics.totalRows = Math.ceil((state.dataset?.tickets.length ?? 0) / gridMetrics.columns);

  const contentHeight =
    padding * 2 +
    gridMetrics.totalRows * ticketHeight +
    Math.max(0, gridMetrics.totalRows - 1) * gap;
  elements.ticketVirtualizer.style.height = `${contentHeight}px`;
  elements.ticketGrid.style.gridTemplateColumns = `repeat(${gridMetrics.columns}, minmax(0, 1fr))`;
}

function renderVisibleTicketGrid() {
  if (!state.dataset) {
    clearFlashingCells();
    ticketElements.clear();
    elements.ticketGrid.replaceChildren();
    return;
  }
  const firstVisibleRow = Math.max(
    0,
    Math.floor((elements.ticketBoard.scrollTop - gridMetrics.padding) / gridMetrics.rowHeight) - 3,
  );
  const renderedRows = Math.ceil(elements.ticketBoard.clientHeight / gridMetrics.rowHeight) + 7;
  const finalVisibleRow = Math.min(gridMetrics.totalRows, firstVisibleRow + renderedRows);
  const startIndex = firstVisibleRow * gridMetrics.columns;
  const endIndex = Math.min(state.dataset.tickets.length, finalVisibleRow * gridMetrics.columns);
  const confirmedTickets = new Set(state.winners.map((winner) => winner.ticketNumber));
  const latestRound = state.drawing ? undefined : state.config.rounds[state.roundIndex - 1];
  const latestTickets = new Set(
    latestRound
      ? state.winners
          .filter((winner) => winner.roundId === latestRound.id)
          .map((winner) => winner.ticketNumber)
      : [],
  );

  clearFlashingCells();
  ticketElements.clear();
  elements.ticketGrid.replaceChildren();
  elements.ticketGrid.style.top = `${gridMetrics.padding + firstVisibleRow * gridMetrics.rowHeight}px`;
  const fragment = document.createDocumentFragment();
  for (let index = startIndex; index < endIndex; index += 1) {
    const ticket = state.dataset.tickets[index];
    const cell = document.createElement("span");
    cell.className = "ticket-cell";
    if (confirmedTickets.has(ticket.ticketNumber)) cell.classList.add("is-confirmed");
    if (latestTickets.has(ticket.ticketNumber)) cell.classList.add("is-latest-winner");
    cell.textContent = ticket.ticketNumber;
    cell.title = ticket.holder ? `${ticket.ticketNumber} · ${ticket.holder}` : ticket.ticketNumber;
    ticketElements.set(ticket.ticketNumber, cell);
    fragment.append(cell);
  }
  elements.ticketGrid.append(fragment);
}

function scheduleVisibleTicketGridRender() {
  if (gridFrame !== null) return;
  gridFrame = requestAnimationFrame(() => {
    gridFrame = null;
    renderVisibleTicketGrid();
  });
}

function renderTicketGrid() {
  elements.loadingWall.hidden = state.dataset !== null;
  if (!state.dataset) {
    elements.ticketVirtualizer.style.height = "100%";
    renderVisibleTicketGrid();
    return;
  }
  readGridMetrics();
  renderVisibleTicketGrid();
  if (gridInitialized) return;
  gridInitialized = true;
  elements.ticketBoard.addEventListener("scroll", scheduleVisibleTicketGridRender, { passive: true });
  new ResizeObserver(() => {
    readGridMetrics();
    renderVisibleTicketGrid();
  }).observe(elements.ticketBoard);
}

function clearFlashingCells() {
  state.flashingCells.forEach((cell) => cell.classList.remove("is-candidate"));
  state.flashingCells.clear();
}

function flashVisibleTickets(slots) {
  clearFlashingCells();
  const visibleCells = Array.from(elements.ticketGrid.children).filter(
    (cell) => !cell.classList.contains("is-confirmed"),
  );
  const targetCount = Math.min(slots, visibleCells.length);
  while (state.flashingCells.size < targetCount) {
    const cell = visibleCells[Math.floor(Math.random() * visibleCells.length)];
    if (!cell) break;
    cell.classList.add("is-candidate");
    state.flashingCells.add(cell);
  }
}

/* ------------------------------------------------------------- rendering */

function findPrize(prizeId) {
  return state.config.prizes.find((prize) => prize.id === prizeId) ?? null;
}

function setFeedback(message, kind = "neutral") {
  elements.datasetStatus.className = `dataset-status is-${kind}`;
  const dot = document.createElement("i");
  dot.setAttribute("aria-hidden", "true");
  elements.datasetStatus.replaceChildren(dot, document.createTextNode(` ${message}`));
}

function resetWinnerStrip() {
  const placeholder = document.createElement("p");
  placeholder.textContent = "Winning tickets will appear here.";
  elements.winnerStrip.replaceChildren(placeholder);
  elements.winnerStrip.classList.remove("has-holders");
  elements.latestRound.textContent = "No winners yet";
}

function renderRoundPlan() {
  elements.roundPlan.replaceChildren();
  const round = state.config.rounds[state.roundIndex];
  if (!round) return;
  round.items.forEach((item) => {
    const prize = findPrize(item.prizeId);
    if (!prize) return;
    const chip = document.createElement("span");
    chip.className = "round-plan-chip";
    const name = document.createElement("strong");
    name.textContent = prize.name;
    const count = document.createElement("em");
    count.textContent = `× ${item.count}`;
    chip.append(createIconElement(prize.icon, "prize-icon is-chip"), name, count);
    if (prize.description) chip.title = prize.description;
    elements.roundPlan.append(chip);
  });
}

function createWinnerLabel(winner, className) {
  const chip = document.createElement("span");
  chip.className = className;
  const ticket = document.createElement("em");
  ticket.textContent = `#${winner.ticketNumber}`;
  if (winner.holder) {
    const holder = document.createElement("strong");
    holder.textContent = winner.holder;
    chip.append(holder, ticket);
  } else {
    chip.append(ticket);
  }
  return chip;
}

function renderLatestWinners(winners, round, animate = true) {
  elements.latestRound.textContent = round.name;
  elements.winnerStrip.replaceChildren();
  elements.winnerStrip.classList.toggle("has-holders", winners.some((winner) => winner.holder));
  winners.forEach((winner, index) => {
    const chip = createWinnerLabel(winner, `winner-chip${animate ? " is-new" : ""}`);
    chip.style.animationDelay = `${Math.min(index * 8, 260)}ms`;
    elements.winnerStrip.append(chip);
  });
}

function renderResultLedger() {
  elements.resultList.replaceChildren();
  const completedRounds = state.config.rounds.slice(0, state.roundIndex).toReversed();
  if (completedRounds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "Completed rounds will appear here.";
    elements.resultList.append(empty);
    return;
  }

  completedRounds.forEach((round) => {
    const roundWinners = state.winners.filter((winner) => winner.roundId === round.id);
    const group = document.createElement("section");
    group.className = "result-group";

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = round.name;
    const copyButton = document.createElement("button");
    copyButton.className = "tier-copy-button";
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => void copyRoundWinners(round, roundWinners, copyButton));
    header.append(title, copyButton);
    group.append(header);

    const prizeIds = [...new Set(roundWinners.map((winner) => winner.prizeId))];
    prizeIds.forEach((prizeId) => {
      const prizeWinners = roundWinners.filter((winner) => winner.prizeId === prizeId);
      const prize = findPrize(prizeId);
      const meta = document.createElement("p");
      meta.className = "result-meta";
      meta.append(createIconElement(prize?.icon ?? "🎁", "prize-icon is-chip"));
      const label = document.createElement("span");
      label.textContent = `${prizeWinners[0].prizeName} · ${prizeWinners.length} ${plural(prizeWinners.length, "winner")}`;
      meta.append(label);

      const tickets = document.createElement("div");
      tickets.className = "result-tickets";
      tickets.classList.toggle("has-holders", prizeWinners.some((winner) => winner.holder));
      prizeWinners.forEach((winner) => {
        tickets.append(createWinnerLabel(winner, "result-ticket"));
      });
      group.append(meta, tickets);
    });

    elements.resultList.append(group);
  });
}

function render() {
  const round = state.config.rounds[state.roundIndex];
  const totalRounds = state.config.rounds.length;
  const totalSlots = countConfiguredSlots(state.config);
  const complete = totalRounds > 0 && state.roundIndex >= totalRounds;
  const hasDataset = state.dataset !== null;
  const configIssues = validateConfig(state.config, state.dataset?.tickets.length ?? Infinity);
  const ready = hasDataset && configIssues.length === 0;
  const hasSeed = state.drawSeed.trim() !== "";
  const seedLocked = state.drawing || state.winners.length > 0 || state.seedRolling;

  elements.programTitle.textContent = state.config.title;
  document.title = state.config.title;
  elements.roundProgress.textContent = `${Math.min(state.roundIndex, totalRounds)} / ${totalRounds}`;
  elements.winnerCount.textContent = `${state.winners.length} / ${totalSlots}`;
  elements.downloadButton.disabled = state.winners.length === 0 || state.drawing;
  elements.settingsButton.disabled = state.drawing;
  elements.soundButton.setAttribute("aria-pressed", String(state.soundEnabled));
  elements.soundButton.querySelector("span:last-child").textContent = state.soundEnabled
    ? "Sound on"
    : "Sound off";
  elements.seedInput.disabled = seedLocked;
  elements.seedRandomizeButton.disabled = seedLocked;
  if (document.activeElement !== elements.seedInput && elements.seedInput.value !== state.drawSeed) {
    elements.seedInput.value = state.drawSeed;
  }

  if (!ready) {
    elements.roundTitle.textContent = hasDataset ? "Draw setup incomplete" : "No tickets imported";
    elements.drawButton.textContent = "Start round";
    elements.drawButton.disabled = true;
    elements.drawMessage.textContent =
      configIssues[0] ?? "Open Settings to import tickets and define prizes";
  } else if (complete) {
    elements.roundTitle.textContent = `All ${totalSlots.toLocaleString()} ${plural(totalSlots, "winner")} confirmed`;
    elements.drawButton.textContent = "Draw complete";
    elements.drawButton.disabled = true;
    elements.drawMessage.textContent = "Results are ready to copy and export";
    elements.broadcastStatus.querySelector("span").textContent = "DRAW COMPLETE";
  } else {
    const roundSlots = countRoundSlots(round);
    elements.roundTitle.textContent = `${round.name} · ${roundSlots} ${plural(roundSlots, "winner")}`;
    elements.drawButton.textContent = state.drawing ? "Drawing…" : `Start ${round.name}`;
    elements.drawButton.disabled = state.drawing || state.seedRolling || !hasSeed;
    if (!state.drawing) {
      elements.drawMessage.textContent = hasSeed
        ? `${state.dataset.tickets.length.toLocaleString()} tickets in the pool`
        : "Enter or randomize a public seed to begin";
      elements.countdownValue.textContent = (DRAW_DURATION_MS / 1000).toFixed(1);
    }
  }

  renderRoundPlan();
  renderResultLedger();
}

/* ------------------------------------------------------------ draw flow */

async function runCountdown(round, slots) {
  const startedAt = performance.now();
  let lastSecond = Math.ceil(DRAW_DURATION_MS / 1000) + 1;

  elements.drawStage.classList.add("is-drawing");
  elements.ticketBoard.classList.add("is-drawing");
  elements.drawMessage.textContent = `${slots} winning ${plural(slots, "ticket")} will remain lit`;
  elements.countdown.classList.add("is-active");
  startCountdownMusic();

  while (true) {
    const elapsed = performance.now() - startedAt;
    const progress = Math.min(1, elapsed / DRAW_DURATION_MS);
    const remainingMs = Math.max(0, DRAW_DURATION_MS - elapsed);
    const remainingSecond = Math.ceil(remainingMs / 1000);
    elements.countdownValue.textContent = (remainingMs / 1000).toFixed(1);
    if (remainingSecond !== lastSecond && remainingSecond > 0) {
      lastSecond = remainingSecond;
      playSecondBeat(remainingSecond);
    }
    if (progress >= 1) break;

    flashVisibleTickets(slots);
    playFlashTick(progress);
    const nextFlashDelay = 100 + Math.pow(progress, 2.5) * 900;
    await wait(Math.min(nextFlashDelay, remainingMs));
  }

  clearFlashingCells();
  stopCountdownMusic();
  elements.ticketBoard.classList.remove("is-drawing");
  elements.drawStage.classList.remove("is-drawing");
  elements.countdown.classList.remove("is-active");
  elements.countdownValue.textContent = "0.0";
  playConfirmation();
}

async function handleDraw() {
  const round = state.config.rounds[state.roundIndex];
  const publicSeed = state.drawSeed.trim();
  if (!state.dataset || !round || state.drawing || publicSeed === "") return;

  state.drawSeed = publicSeed;
  state.drawing = true;
  ensureAudioContext();
  elements.broadcastStatus.classList.add("is-live");
  elements.broadcastStatus.querySelector("span").textContent = "LIVE DRAW";
  renderVisibleTicketGrid();
  render();

  try {
    const winners = await drawRound({
      tickets: state.dataset.tickets,
      round,
      prizes: state.config.prizes,
      previousWinners: state.winners,
      publicSeed,
    });
    await runCountdown(round, countRoundSlots(round));

    const confirmedAt = new Date().toISOString();
    winners.forEach((winner) => {
      winner.drawnAt = confirmedAt;
    });
    state.winners.push(...winners);
    state.roundIndex += 1;
    state.drawnAt = confirmedAt;
    state.drawing = false;
    persistSession();

    elements.broadcastStatus.classList.remove("is-live");
    elements.broadcastStatus.querySelector("span").textContent = "RESULTS CONFIRMED";
    elements.drawMessage.textContent = `${winners.length} winning ${plural(winners.length, "ticket")} confirmed`;
    renderVisibleTicketGrid();
    renderLatestWinners(winners, round);
    render();
    showCelebration(round, winners);
  } catch (error) {
    state.drawing = false;
    clearFlashingCells();
    stopCountdownMusic();
    elements.ticketBoard.classList.remove("is-drawing");
    elements.drawStage.classList.remove("is-drawing");
    elements.countdown.classList.remove("is-active");
    elements.broadcastStatus.classList.remove("is-live");
    elements.broadcastStatus.querySelector("span").textContent = "DRAW ERROR";
    elements.drawMessage.textContent =
      error instanceof Error ? error.message : "Unable to complete the draw";
    render();
  }
}

/* --------------------------------------------------------- celebration */

function showCelebration(round, winners) {
  const isFinalRound = state.roundIndex >= state.config.rounds.length;
  elements.celebrateBadge.textContent = isFinalRound
    ? "DRAW COMPLETE"
    : `${round.name.toUpperCase()} · COMPLETE`;
  elements.celebrateSubtitle.textContent = `${winners.length} ${plural(winners.length, "winner")} just drawn${
    isFinalRound ? " — that is every round done." : ""
  }`;

  elements.celebratePrizes.replaceChildren();
  const prizeIds = [...new Set(winners.map((winner) => winner.prizeId))];
  prizeIds.forEach((prizeId) => {
    const prizeWinners = winners.filter((winner) => winner.prizeId === prizeId);
    const prize = findPrize(prizeId);
    const card = document.createElement("article");
    card.className = "celebrate-prize";

    const header = document.createElement("header");
    header.append(createIconElement(prize?.icon ?? "🎁", "prize-icon is-large"));
    const heading = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = prizeWinners[0].prizeName;
    heading.append(name);
    if (prize?.description) {
      const description = document.createElement("p");
      description.textContent = prize.description;
      heading.append(description);
    }
    const count = document.createElement("span");
    count.className = "celebrate-count";
    count.textContent = `${prizeWinners.length} ${plural(prizeWinners.length, "winner")}`;
    header.append(heading, count);

    const list = document.createElement("div");
    list.className = "celebrate-winners";
    prizeWinners.slice(0, CELEBRATE_WINNER_LIMIT).forEach((winner) => {
      list.append(createWinnerLabel(winner, "celebrate-winner"));
    });
    const hiddenCount = prizeWinners.length - CELEBRATE_WINNER_LIMIT;
    if (hiddenCount > 0) {
      const more = document.createElement("span");
      more.className = "celebrate-more";
      more.textContent = `and ${hiddenCount.toLocaleString()} ${plural(hiddenCount, "other")}`;
      list.append(more);
    }

    card.append(header, list);
    elements.celebratePrizes.append(card);
  });

  elements.celebrateOverlay.hidden = false;
  startCelebrateMusic();
  elements.celebrateContinue.focus();
}

function closeCelebration() {
  elements.celebrateOverlay.hidden = true;
  elements.celebratePrizes.replaceChildren();
  stopCelebrateMusic();
}

/* ----------------------------------------------------------- settings */

function renderSodexPreset() {
  const preview = document.querySelector("#sodex-preset-preview");
  for (const box of SODEX_BOXES) {
    const card = document.createElement("div");
    card.className = "preset-tier";
    card.style.setProperty("--tier-color", box.color);
    const image = document.createElement("img");
    image.src = box.icon;
    image.alt = `${box.name} Treasure Box`;
    const name = document.createElement("strong");
    name.textContent = box.name;
    const range = document.createElement("span");
    range.textContent = box.range;
    card.append(image, name, range);
    preview.append(card);
  }
}

renderSodexPreset();
document.querySelector("#sodex-preset-button").addEventListener("click", () => {
  if (!draft.config) return;
  draft.config = applySodexPreset(draft.config);
  renderPrizeEditor();
  renderRoundEditor();
  renderSettingsSummary();
  document.querySelector("#sodex-preset-status").textContent =
    "SoDEX preset applied to draft · 4 tiers, 4 rounds. Adjust winner counts below and save when ready.";
});

function openSettings() {
  if (state.drawing) return;
  draft.config = normalizeConfig(structuredClone(state.config));
  draft.dataset = state.dataset;
  draft.ticketStatus = "";
  draft.ticketStatusKind = "neutral";
  document.querySelector("#sodex-preset-status").textContent = "";
  elements.configTitle.value = draft.config.title;
  elements.ticketTextarea.value = "";
  renderPrizeEditor();
  renderRoundEditor();
  renderTicketImportStatus();
  renderSettingsSummary();
  elements.settingsOverlay.hidden = false;
  elements.configTitle.focus();
}

function closeSettings() {
  elements.settingsOverlay.hidden = true;
  draft.config = null;
  draft.dataset = null;
}

function renderTicketImportStatus() {
  const element = elements.ticketImportStatus;
  element.className = `import-status is-${draft.ticketStatusKind}`;
  if (draft.ticketStatus !== "") {
    element.textContent = draft.ticketStatus;
    return;
  }
  if (!draft.dataset) {
    element.textContent = "No tickets imported";
    return;
  }
  const holders = draft.dataset.tickets.filter((ticket) => ticket.holder).length;
  element.textContent = `${draft.dataset.tickets.length.toLocaleString()} tickets · ${holders.toLocaleString()} with a name · SHA-256 ${draft.dataset.datasetHash.slice(0, 12)}…`;
}

function renderSettingsSummary() {
  const issues = validateConfig(draft.config, draft.dataset?.tickets.length ?? Infinity);
  const totalSlots = countConfiguredSlots(draft.config);
  if (!draft.dataset) issues.unshift("Import the ticket list.");
  elements.settingsSummary.className = `settings-summary${issues.length > 0 ? " is-error" : ""}`;
  elements.settingsSummary.textContent =
    issues.length > 0
      ? issues[0]
      : `${draft.config.rounds.length} ${plural(draft.config.rounds.length, "round")} · ${draft.config.prizes.length} ${plural(draft.config.prizes.length, "prize")} · ${totalSlots.toLocaleString()} ${plural(totalSlots, "winner")} of ${draft.dataset.tickets.length.toLocaleString()} tickets`;
  elements.settingsSave.disabled = issues.length > 0;
}

function syncPrizeOptionLabels() {
  elements.roundEditor.querySelectorAll("select[data-prize-select]").forEach((select) => {
    Array.from(select.options).forEach((option) => {
      const prize = draft.config.prizes.find((candidate) => candidate.id === option.value);
      if (prize) option.textContent = prize.name;
    });
  });
}

function labeledField(labelText, control) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.textContent = labelText;
  label.append(span, control);
  return label;
}

function renderPrizeEditor() {
  elements.prizeEditor.replaceChildren();
  if (draft.config.prizes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "editor-empty";
    empty.textContent = "No prizes yet. Add the first one below.";
    elements.prizeEditor.append(empty);
  }

  draft.config.prizes.forEach((prize, index) => {
    const card = document.createElement("article");
    card.className = "editor-card";

    const iconField = document.createElement("div");
    iconField.className = "prize-icon-field";
    const dropzone = document.createElement("label");
    dropzone.className = "icon-dropzone";
    dropzone.title = "Upload an image for this prize";
    const preview = createIconElement(prize.icon, "prize-icon is-large");
    const hint = document.createElement("span");
    hint.className = "icon-hint";
    hint.textContent = "Upload";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    fileInput.hidden = true;
    fileInput.addEventListener("change", async () => {
      const [file] = fileInput.files ?? [];
      fileInput.value = "";
      if (!file) return;
      try {
        prize.icon = sanitizeIcon(await fileToIconDataUrl(file));
        renderPrizeEditor();
        renderSettingsSummary();
      } catch (error) {
        draft.ticketStatus = "";
        window.alert(error instanceof Error ? error.message : "Unable to use that image");
      }
    });
    dropzone.append(preview, hint, fileInput);

    const emojiInput = document.createElement("input");
    emojiInput.type = "text";
    emojiInput.maxLength = 8;
    emojiInput.className = "icon-emoji";
    emojiInput.placeholder = "Emoji";
    emojiInput.value = isImageIcon(prize.icon) ? "" : prize.icon;
    emojiInput.addEventListener("input", () => {
      prize.icon = sanitizeIcon(emojiInput.value);
      renderIconInto(preview, prize.icon);
    });
    iconField.append(dropzone, labeledField("Or emoji", emojiInput));

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.value = prize.name;
    nameInput.placeholder = `Prize ${index + 1}`;
    nameInput.addEventListener("input", () => {
      prize.name = nameInput.value.trim() === "" ? `Prize ${index + 1}` : nameInput.value;
      syncPrizeOptionLabels();
      renderSettingsSummary();
    });

    const descriptionInput = document.createElement("input");
    descriptionInput.type = "text";
    descriptionInput.maxLength = 160;
    descriptionInput.value = prize.description;
    descriptionInput.placeholder = "Shown in the congratulations popup";
    descriptionInput.addEventListener("input", () => {
      prize.description = descriptionInput.value;
    });

    const fields = document.createElement("div");
    fields.className = "editor-fields";
    fields.append(labeledField("Name", nameInput), labeledField("Description", descriptionInput));

    const removeButton = document.createElement("button");
    removeButton.className = "icon-button is-danger";
    removeButton.type = "button";
    removeButton.title = "Remove this prize";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      draft.config.prizes = draft.config.prizes.filter((candidate) => candidate.id !== prize.id);
      draft.config.rounds.forEach((round) => {
        round.items = round.items.filter((item) => item.prizeId !== prize.id);
      });
      renderPrizeEditor();
      renderRoundEditor();
      renderSettingsSummary();
    });

    card.append(iconField, fields, removeButton);
    elements.prizeEditor.append(card);
  });
}

function renderRoundEditor() {
  elements.roundEditor.replaceChildren();
  if (draft.config.rounds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "editor-empty";
    empty.textContent = "No rounds yet. Add the first one below.";
    elements.roundEditor.append(empty);
  }

  draft.config.rounds.forEach((round, roundIndex) => {
    const card = document.createElement("article");
    card.className = "editor-card is-round";

    const header = document.createElement("header");
    const order = document.createElement("span");
    order.className = "round-order";
    order.textContent = String(roundIndex + 1);
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 60;
    nameInput.value = round.name;
    nameInput.placeholder = `Round ${roundIndex + 1}`;
    nameInput.addEventListener("input", () => {
      round.name = nameInput.value.trim() === "" ? `Round ${roundIndex + 1}` : nameInput.value;
    });

    const moveUp = document.createElement("button");
    moveUp.className = "icon-button";
    moveUp.type = "button";
    moveUp.title = "Move up";
    moveUp.textContent = "↑";
    moveUp.disabled = roundIndex === 0;
    moveUp.addEventListener("click", () => {
      const [moved] = draft.config.rounds.splice(roundIndex, 1);
      draft.config.rounds.splice(roundIndex - 1, 0, moved);
      renderRoundEditor();
    });

    const moveDown = document.createElement("button");
    moveDown.className = "icon-button";
    moveDown.type = "button";
    moveDown.title = "Move down";
    moveDown.textContent = "↓";
    moveDown.disabled = roundIndex === draft.config.rounds.length - 1;
    moveDown.addEventListener("click", () => {
      const [moved] = draft.config.rounds.splice(roundIndex, 1);
      draft.config.rounds.splice(roundIndex + 1, 0, moved);
      renderRoundEditor();
    });

    const removeButton = document.createElement("button");
    removeButton.className = "icon-button is-danger";
    removeButton.type = "button";
    removeButton.title = "Remove this round";
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      draft.config.rounds = draft.config.rounds.filter((candidate) => candidate.id !== round.id);
      renderRoundEditor();
      renderSettingsSummary();
    });

    header.append(order, labeledField("Round name", nameInput), moveUp, moveDown, removeButton);

    const itemList = document.createElement("div");
    itemList.className = "round-items";
    round.items.forEach((item, itemIndex) => {
      const row = document.createElement("div");
      row.className = "round-item";

      const select = document.createElement("select");
      select.dataset.prizeSelect = "true";
      draft.config.prizes.forEach((prize) => {
        const option = document.createElement("option");
        option.value = prize.id;
        option.textContent = prize.name;
        select.append(option);
      });
      select.value = item.prizeId;
      select.addEventListener("change", () => {
        item.prizeId = select.value;
      });

      const countInput = document.createElement("input");
      countInput.type = "number";
      countInput.min = "1";
      countInput.step = "1";
      countInput.value = String(item.count);
      countInput.addEventListener("input", () => {
        item.count = Math.max(1, Math.floor(Number(countInput.value)) || 1);
        renderSettingsSummary();
      });
      countInput.addEventListener("blur", () => {
        countInput.value = String(item.count);
      });

      const removeItem = document.createElement("button");
      removeItem.className = "icon-button is-danger";
      removeItem.type = "button";
      removeItem.title = "Remove this prize from the round";
      removeItem.textContent = "×";
      removeItem.addEventListener("click", () => {
        round.items.splice(itemIndex, 1);
        renderRoundEditor();
        renderSettingsSummary();
      });

      row.append(labeledField("Prize", select), labeledField("Winners", countInput), removeItem);
      itemList.append(row);
    });

    const addItem = document.createElement("button");
    addItem.className = "ghost-button is-small";
    addItem.type = "button";
    addItem.textContent = "+ Add prize to this round";
    addItem.disabled = draft.config.prizes.length === 0;
    addItem.addEventListener("click", () => {
      round.items.push({ prizeId: draft.config.prizes[0].id, count: 1 });
      renderRoundEditor();
      renderSettingsSummary();
    });

    card.append(header, itemList, addItem);
    elements.roundEditor.append(card);
  });
}

async function importDraftTickets(source, label) {
  try {
    draft.dataset = await validateTicketDataset(parseTicketSource(source));
    draft.ticketStatus = "";
    draft.ticketStatusKind = "success";
  } catch (error) {
    draft.ticketStatus = `${label}: ${error instanceof Error ? error.message : "import failed"}`;
    draft.ticketStatusKind = "error";
  }
  renderTicketImportStatus();
  renderSettingsSummary();
}

function saveSettings() {
  const nextConfig = normalizeConfig({ ...draft.config, title: elements.configTitle.value });
  const nextDataset = draft.dataset;
  if (validateConfig(nextConfig, nextDataset?.tickets.length ?? Infinity).length > 0 || !nextDataset) {
    renderSettingsSummary();
    return;
  }

  const setupChanged =
    nextDataset.datasetHash !== state.dataset?.datasetHash ||
    JSON.stringify(nextConfig) !== JSON.stringify(state.config);
  if (
    state.winners.length > 0 &&
    setupChanged &&
    !window.confirm("Saving these settings clears the current draw results. Continue?")
  ) {
    return;
  }

  state.config = nextConfig;
  state.dataset = nextDataset;
  if (setupChanged) {
    state.winners = [];
    state.roundIndex = 0;
    state.drawnAt = null;
    state.drawSeed = createRandomSeed();
    localStorage.removeItem(SESSION_KEY);
    resetWinnerStrip();
    elements.broadcastStatus.classList.remove("is-live");
    elements.broadcastStatus.querySelector("span").textContent = "READY";
  }

  const persisted = persistSetup();
  setFeedback(
    persisted
      ? `${state.dataset.tickets.length.toLocaleString()} tickets ready`
      : `${state.dataset.tickets.length.toLocaleString()} tickets ready (too large to save locally)`,
    persisted ? "success" : "neutral",
  );
  closeSettings();
  renderTicketGrid();
  render();
}

function exportConfig() {
  const config = normalizeConfig({ ...draft.config, title: elements.configTitle.value });
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "lucky-draw-config.json";
  link.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------- actions */

function resetDraw() {
  if (state.winners.length > 0 && !window.confirm("Reset all draw results?")) return;
  clearFlashingCells();
  stopCountdownMusic();
  stopCelebrateMusic();
  closeCelebration();
  state.winners = [];
  state.roundIndex = 0;
  state.drawnAt = null;
  state.drawing = false;
  state.drawSeed = createRandomSeed();
  renderVisibleTicketGrid();
  resetWinnerStrip();
  elements.broadcastStatus.classList.remove("is-live");
  elements.broadcastStatus.querySelector("span").textContent = "READY";
  elements.countdownValue.textContent = (DRAW_DURATION_MS / 1000).toFixed(1);
  localStorage.removeItem(SESSION_KEY);
  render();
  elements.ticketBoard.scrollTo({ top: 0, behavior: "auto" });
}

function downloadResults() {
  if (!state.dataset || state.winners.length === 0) return;
  const csv = buildResultsCsv({
    winners: state.winners,
    datasetHash: state.dataset.datasetHash,
    publicSeed: state.drawSeed,
    drawnAt: state.drawnAt ?? new Date().toISOString(),
  });
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `lucky-draw-results-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

async function copyRoundWinners(round, winners, button) {
  if (winners.length === 0) return;
  const prizeIds = [...new Set(winners.map((winner) => winner.prizeId))];
  const body = prizeIds
    .map((prizeId) => {
      const prizeWinners = winners.filter((winner) => winner.prizeId === prizeId);
      const lines = prizeWinners
        .map((winner) => (winner.holder ? `#${winner.ticketNumber} ${winner.holder}` : `#${winner.ticketNumber}`))
        .join(" ");
      return `${prizeWinners[0].prizeName} (${prizeWinners.length})\n${lines}`;
    })
    .join("\n\n");
  await writeClipboard(`${round.name}\n${body}`);
  button.textContent = `Copied ${winners.length}`;
  playTone({ frequency: 660, duration: 0.16, gain: 0.035, type: "triangle" });
  window.setTimeout(() => {
    button.textContent = "Copy";
  }, 1_600);
}

const SEED_ROLL_DURATION_MS = 3_000;

async function randomizeSeed() {
  if (state.drawing || state.winners.length > 0 || state.seedRolling) return;
  state.seedRolling = true;
  ensureAudioContext();
  render();

  const startedAt = performance.now();
  elements.seedInput.classList.add("is-rolling");
  while (true) {
    const progress = Math.min(1, (performance.now() - startedAt) / SEED_ROLL_DURATION_MS);
    elements.seedInput.value = createRandomSeed();
    playTone({
      frequency: 900 + progress * 500,
      duration: 0.03,
      gain: 0.02 + progress * 0.015,
      type: "square",
    });
    if (progress >= 1) break;
    await wait(50 + Math.pow(progress, 2.2) * 300);
  }
  elements.seedInput.classList.remove("is-rolling");

  state.drawSeed = createRandomSeed();
  state.seedRolling = false;
  playTone({ frequency: 587.33, duration: 0.3, gain: 0.05, type: "triangle" });
  playTone({ frequency: 880, duration: 0.45, gain: 0.05, delay: 0.09, type: "triangle" });
  render();
}

async function copySeed(button) {
  const seed = state.drawSeed.trim();
  if (seed === "") return;
  await writeClipboard(seed);
  playTone({ frequency: 660, duration: 0.16, gain: 0.035, type: "triangle" });
  const originalText = button.textContent;
  button.textContent = "Copied";
  window.setTimeout(() => {
    button.textContent = originalText;
  }, 1_600);
}

function toggleSound() {
  state.soundEnabled = !state.soundEnabled;
  countdownMusic.muted = !state.soundEnabled;
  celebrateMusic.muted = !state.soundEnabled;
  if (state.soundEnabled) {
    ensureAudioContext();
    playTone({ frequency: 520, duration: 0.12, gain: 0.03, type: "triangle" });
  }
  render();
}

/* ------------------------------------------------------------- wiring */

elements.settingsButton.addEventListener("click", openSettings);
elements.settingsClose.addEventListener("click", closeSettings);
elements.settingsCancel.addEventListener("click", closeSettings);
elements.settingsSave.addEventListener("click", saveSettings);
elements.exportConfigButton.addEventListener("click", exportConfig);
elements.configTitle.addEventListener("input", () => {
  draft.config.title = elements.configTitle.value;
});
elements.addPrizeButton.addEventListener("click", () => {
  draft.config.prizes.push(createPrize({ name: `Prize ${draft.config.prizes.length + 1}` }));
  renderPrizeEditor();
  renderRoundEditor();
  renderSettingsSummary();
});
elements.addRoundButton.addEventListener("click", () => {
  const index = draft.config.rounds.length + 1;
  draft.config.rounds.push(
    createRound({
      name: `Round ${index}`,
      items: draft.config.prizes.length > 0 ? [{ prizeId: draft.config.prizes[0].id, count: 1 }] : [],
    }),
  );
  renderRoundEditor();
  renderSettingsSummary();
});
elements.ticketFile.addEventListener("change", async () => {
  const [file] = elements.ticketFile.files ?? [];
  elements.ticketFile.value = "";
  if (!file) return;
  await importDraftTickets(await file.text(), file.name);
});
elements.ticketApplyButton.addEventListener("click", () => {
  const source = elements.ticketTextarea.value;
  if (source.trim() === "") {
    draft.ticketStatus = "Paste a ticket list first";
    draft.ticketStatusKind = "error";
    renderTicketImportStatus();
    return;
  }
  void importDraftTickets(source, "Pasted list");
});
elements.ticketSampleButton.addEventListener("click", async () => {
  try {
    const response = await fetch("../../ticket-map.csv", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await importDraftTickets(await response.text(), "ticket-map.csv");
  } catch (error) {
    draft.ticketStatus = `ticket-map.csv: ${error instanceof Error ? error.message : "unavailable"}`;
    draft.ticketStatusKind = "error";
    renderTicketImportStatus();
  }
});
elements.ticketClearButton.addEventListener("click", () => {
  draft.dataset = null;
  draft.ticketStatus = "";
  draft.ticketStatusKind = "neutral";
  elements.ticketTextarea.value = "";
  renderTicketImportStatus();
  renderSettingsSummary();
});
elements.configFile.addEventListener("change", async () => {
  const [file] = elements.configFile.files ?? [];
  elements.configFile.value = "";
  if (!file) return;
  try {
    draft.config = normalizeConfig(JSON.parse(await file.text()));
    elements.configTitle.value = draft.config.title;
    renderPrizeEditor();
    renderRoundEditor();
    renderSettingsSummary();
  } catch {
    window.alert("That file is not a valid draw config");
  }
});

elements.downloadButton.addEventListener("click", downloadResults);
elements.drawButton.addEventListener("click", () => void handleDraw());
elements.resetButton.addEventListener("click", resetDraw);
elements.seedInput.addEventListener("input", (event) => {
  state.drawSeed = event.currentTarget.value;
  render();
});
elements.seedRandomizeButton.addEventListener("click", () => void randomizeSeed());
elements.seedCopyButton.addEventListener("click", (event) => void copySeed(event.currentTarget));
elements.soundButton.addEventListener("click", toggleSound);
elements.celebrateClose.addEventListener("click", closeCelebration);
elements.celebrateContinue.addEventListener("click", closeCelebration);
elements.drawStage.addEventListener(
  "wheel",
  (event) => {
    if (elements.ticketBoard.contains(event.target) || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    elements.ticketBoard.scrollBy({ top: event.deltaY });
    event.preventDefault();
  },
  { passive: false },
);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!elements.celebrateOverlay.hidden) closeCelebration();
  else if (!elements.settingsOverlay.hidden) closeSettings();
});

async function bootstrap() {
  const restored = await restoreSetup();
  if (state.dataset) {
    restoreSession();
    setFeedback(`${state.dataset.tickets.length.toLocaleString()} tickets ready`, "success");
  } else {
    setFeedback("No tickets imported", "neutral");
  }
  renderTicketGrid();
  render();
  if (!restored || !state.dataset) openSettings();
}

void bootstrap();
