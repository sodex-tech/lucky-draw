import {
  PRIZE_TIERS,
  buildResultsCsv,
  createRandomSeed,
  drawPrizeTier,
  parseTicketCsv,
  validateTicketDataset,
} from "../../draw-engine.mjs";

const DRAW_DURATION_MS = 10_000;
const SESSION_KEY = "public-ticket-draw-v1";

const state = {
  dataset: null,
  winners: [],
  tierIndex: 0,
  drawnAt: null,
  drawing: false,
  soundEnabled: true,
  flashingCells: new Set(),
  drawSeed: createRandomSeed(),
  seedRolling: false,
  voiceEnabled: true,
  introPlaying: false,
};

const ticketElements = new Map();

const elements = {
  broadcastStatus: document.querySelector("#broadcast-status"),
  countdown: document.querySelector("#countdown"),
  countdownValue: document.querySelector("#countdown-value"),
  datasetStatus: document.querySelector("#dataset-status"),
  downloadButton: document.querySelector("#download-button"),
  drawButton: document.querySelector("#draw-button"),
  drawMessage: document.querySelector("#draw-message"),
  drawStage: document.querySelector("#draw-stage"),
  latestTier: document.querySelector("#latest-tier"),
  loadingWall: document.querySelector("#loading-wall"),
  resetButton: document.querySelector("#reset-button"),
  resultList: document.querySelector("#result-list"),
  rulesButton: document.querySelector("#rules-button"),
  seedCopyButton: document.querySelector("#seed-copy-button"),
  seedInput: document.querySelector("#seed-input"),
  seedRandomizeButton: document.querySelector("#seed-randomize-button"),
  soundButton: document.querySelector("#sound-button"),
  ticketBoard: document.querySelector("#ticket-board"),
  ticketGrid: document.querySelector("#ticket-grid"),
  ticketVirtualizer: document.querySelector("#ticket-virtualizer"),
  tierProgress: document.querySelector("#tier-progress"),
  tierTitle: document.querySelector("#tier-title"),
  voiceButton: document.querySelector("#voice-button"),
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

const countdownMusic = new Audio(new URL("./assets/countdown-bgm.mp3", import.meta.url).href);
countdownMusic.preload = "auto";
countdownMusic.volume = 0.22;

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

const VOICE_CLIPS = [
  "randomize-1",
  "randomize-2",
  "randomize-3",
  "randomize-4",
  "randomize-5",
  "intro-1",
  "intro-2",
  "intro-3",
  "tier-fourth-1",
  "tier-fourth-2",
  "tier-third-1",
  "tier-third-2",
  "tier-second-1",
  "tier-second-2",
  "tier-first-1",
  "tier-first-2",
  "done-fourth",
  "done-third",
  "done-second",
  "complete",
];

const voiceClips = new Map(VOICE_CLIPS.map((name) => {
  const clip = new Audio(new URL(`./assets/voice/${name}.mp3`, import.meta.url).href);
  clip.preload = "auto";
  clip.volume = 0.9;
  return [name, clip];
}));

const introMusic = new Audio(new URL("./assets/intro-bgm.mp3", import.meta.url).href);
introMusic.preload = "auto";
introMusic.loop = true;
introMusic.volume = 0.13;

let activeVoice = null;
let voiceQueue = [];
let voiceSequenceEnd = null;

function finishVoiceSequence(completed) {
  activeVoice = null;
  voiceQueue = [];
  const onDone = voiceSequenceEnd;
  voiceSequenceEnd = null;
  if (onDone) onDone(completed);
}

function stopVoice() {
  if (activeVoice) {
    activeVoice.pause();
    activeVoice.currentTime = 0;
  }
  finishVoiceSequence(false);
}

function playNextVoiceInQueue() {
  const name = voiceQueue.shift();
  if (!name) {
    finishVoiceSequence(true);
    return;
  }
  const clip = voiceClips.get(name);
  if (!clip) {
    playNextVoiceInQueue();
    return;
  }
  activeVoice = clip;
  clip.currentTime = 0;
  clip.onended = () => {
    if (activeVoice === clip) playNextVoiceInQueue();
  };
  void clip.play().catch(() => {
    if (activeVoice === clip) playNextVoiceInQueue();
  });
}

function playVoiceSequence(names, onDone = null) {
  if (!state.voiceEnabled) {
    if (onDone) onDone(false);
    return;
  }
  stopVoice();
  voiceQueue = [...names];
  voiceSequenceEnd = onDone;
  playNextVoiceInQueue();
}

function playVoice(name) {
  playVoiceSequence([name]);
}

function playTierAnnouncement(tier) {
  const variant = Math.random() < 0.5 ? 1 : 2;
  playVoice(`tier-${tier.key}-${variant}`);
}

function stopIntro() {
  introMusic.pause();
  introMusic.currentTime = 0;
  state.introPlaying = false;
}

function playIntro() {
  if (state.introPlaying) {
    stopVoice();
    return;
  }
  if (state.drawing || !state.voiceEnabled) return;
  state.introPlaying = true;
  if (state.soundEnabled) {
    introMusic.currentTime = 0;
    void introMusic.play().catch(() => {});
  }
  render();
  playVoiceSequence(["intro-1", "intro-2", "intro-3"], () => {
    stopIntro();
    render();
  });
}

function playConfirmation() {
  [392, 523.25, 659.25, 783.99].forEach((frequency, index) => {
    playTone({ frequency, duration: 0.55, gain: 0.045, delay: index * 0.09, type: "triangle" });
  });
}

function setFeedback(message, kind = "neutral") {
  elements.datasetStatus.className = `dataset-status is-${kind}`;
  elements.datasetStatus.innerHTML = `<i aria-hidden="true"></i>${message}`;
}

function persistSession() {
  if (!state.dataset) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    datasetHash: state.dataset.datasetHash,
    winners: state.winners,
    tierIndex: state.tierIndex,
    drawnAt: state.drawnAt,
    drawSeed: state.drawSeed,
  }));
}

function restoreSession() {
  if (!state.dataset) return;
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (!saved || saved.datasetHash !== state.dataset.datasetHash || !Array.isArray(saved.winners)) return;
    state.winners = saved.winners;
    state.tierIndex = Number(saved.tierIndex) || 0;
    state.drawnAt = saved.drawnAt ?? null;
    if (typeof saved.drawSeed === "string" && saved.drawSeed.trim() !== "") {
      state.drawSeed = saved.drawSeed;
    }
    renderVisibleTicketGrid();
    const latestTier = PRIZE_TIERS[state.tierIndex - 1];
    if (latestTier) {
      const latestWinners = state.winners.filter((winner) => winner.prizeLevel === latestTier.label);
      renderLatestWinners(latestWinners, latestTier, false);
    }
  } catch {
    localStorage.removeItem(SESSION_KEY);
  }
}

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

  const contentHeight = padding * 2
    + gridMetrics.totalRows * ticketHeight
    + Math.max(0, gridMetrics.totalRows - 1) * gap;
  elements.ticketVirtualizer.style.height = `${contentHeight}px`;
  elements.ticketGrid.style.gridTemplateColumns = `repeat(${gridMetrics.columns}, minmax(0, 1fr))`;
}

function renderVisibleTicketGrid() {
  if (!state.dataset) return;
  const firstVisibleRow = Math.max(
    0,
    Math.floor((elements.ticketBoard.scrollTop - gridMetrics.padding) / gridMetrics.rowHeight) - 3,
  );
  const renderedRows = Math.ceil(elements.ticketBoard.clientHeight / gridMetrics.rowHeight) + 7;
  const finalVisibleRow = Math.min(gridMetrics.totalRows, firstVisibleRow + renderedRows);
  const startIndex = firstVisibleRow * gridMetrics.columns;
  const endIndex = Math.min(state.dataset.tickets.length, finalVisibleRow * gridMetrics.columns);
  const confirmedTickets = new Set(state.winners.map((winner) => winner.ticketNumber));
  const latestTier = state.drawing ? undefined : PRIZE_TIERS[state.tierIndex - 1];
  const latestTickets = new Set(
    latestTier
      ? state.winners
        .filter((winner) => winner.prizeLevel === latestTier.label)
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
    cell.title = `Ticket #${ticket.ticketNumber}`;
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
  if (!state.dataset) return;
  readGridMetrics();
  renderVisibleTicketGrid();
  elements.loadingWall.hidden = true;
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

function getVisibleTicketCells() {
  return Array.from(elements.ticketGrid.children)
    .filter((cell) => !cell.classList.contains("is-confirmed"));
}

function flashVisibleTickets(slots) {
  clearFlashingCells();
  const visibleCells = getVisibleTicketCells();
  const targetCount = Math.min(slots, visibleCells.length);
  while (state.flashingCells.size < targetCount && state.flashingCells.size < visibleCells.length) {
    const cell = visibleCells[Math.floor(Math.random() * visibleCells.length)];
    if (cell) {
      cell.classList.add("is-candidate");
      state.flashingCells.add(cell);
    }
  }
}

function renderResultLedger() {
  elements.resultList.replaceChildren();
  const completedTiers = PRIZE_TIERS.slice(0, state.tierIndex).toReversed();
  if (completedTiers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent = "Completed prize tiers will appear here.";
    elements.resultList.append(empty);
    return;
  }
  completedTiers.forEach((tier) => {
    const winners = state.winners.filter((winner) => winner.prizeLevel === tier.label);
    const group = document.createElement("section");
    group.className = "result-group";
    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.textContent = tier.label;
    const copyButton = document.createElement("button");
    copyButton.className = "tier-copy-button";
    copyButton.type = "button";
    copyButton.textContent = "Copy";
    copyButton.addEventListener("click", () => void copyTierTickets(tier, winners, copyButton));
    const heading = document.createElement("div");
    heading.append(title);
    header.append(heading, copyButton);
    const meta = document.createElement("p");
    meta.className = "result-meta";
    meta.textContent = `${winners.length} ticket${winners.length === 1 ? "" : "s"} confirmed`;
    const tickets = document.createElement("div");
    tickets.className = "result-tickets";
    winners.forEach((winner) => {
      const number = document.createElement("span");
      number.textContent = `#${winner.ticketNumber}`;
      tickets.append(number);
    });
    group.append(header, meta, tickets);
    elements.resultList.append(group);
  });
}

function renderLatestWinners(winners, tier, animate = true) {
  elements.latestTier.textContent = tier.label;
  elements.winnerStrip.replaceChildren();
  winners.forEach((winner, index) => {
    const chip = document.createElement("span");
    chip.className = `winner-chip${animate ? " is-new" : ""}`;
    chip.style.animationDelay = `${Math.min(index * 8, 260)}ms`;
    chip.textContent = `#${winner.ticketNumber}`;
    elements.winnerStrip.append(chip);
  });
}

function render() {
  const tier = PRIZE_TIERS[state.tierIndex];
  const complete = state.tierIndex >= PRIZE_TIERS.length;
  const hasDataset = state.dataset !== null;
  const hasSeed = state.drawSeed.trim() !== "";
  const seedLocked = state.drawing || state.winners.length > 0 || state.seedRolling;
  elements.tierProgress.textContent = `${Math.min(state.tierIndex, 4)} / 4`;
  elements.winnerCount.textContent = `${state.winners.length} / 500`;
  elements.downloadButton.disabled = state.winners.length === 0 || state.drawing;
  elements.soundButton.setAttribute("aria-pressed", String(state.soundEnabled));
  elements.soundButton.querySelector("span:last-child").textContent = state.soundEnabled ? "Sound on" : "Sound off";
  elements.voiceButton.setAttribute("aria-pressed", String(state.voiceEnabled));
  elements.voiceButton.querySelector("span:last-child").textContent = state.voiceEnabled ? "Voice on" : "Voice off";
  elements.rulesButton.textContent = state.introPlaying ? "Stop intro" : "Intro & Rules";
  elements.rulesButton.disabled = state.drawing || !state.voiceEnabled;
  elements.seedInput.disabled = seedLocked;
  elements.seedRandomizeButton.disabled = seedLocked;
  if (document.activeElement !== elements.seedInput && elements.seedInput.value !== state.drawSeed) {
    elements.seedInput.value = state.drawSeed;
  }

  if (!hasDataset) {
    elements.tierTitle.textContent = "Validating official ticket map";
    elements.drawButton.textContent = "Loading ticket map";
    elements.drawButton.disabled = true;
  } else if (complete) {
    elements.tierTitle.textContent = "All 500 winning tickets confirmed";
    elements.drawButton.textContent = "Draw complete";
    elements.drawButton.disabled = true;
    elements.drawMessage.textContent = "Results are ready to copy and export";
    elements.broadcastStatus.querySelector("span").textContent = "DRAW COMPLETE";
  } else {
    elements.tierTitle.textContent = `${tier.label} · ${tier.slots} winner${tier.slots === 1 ? "" : "s"}`;
    elements.drawButton.textContent = state.drawing ? "Drawing…" : `Start ${tier.label}`;
    elements.drawButton.disabled = state.drawing || state.seedRolling || !hasSeed;
    if (!state.drawing) {
      elements.drawMessage.textContent = hasSeed
        ? "All tickets are arranged in numerical order"
        : "Enter or randomize a public seed to begin";
      elements.countdownValue.textContent = "10.0";
    }
  }
  renderResultLedger();
}

async function runCountdown(winners, tier) {
  const startedAt = performance.now();
  let lastSecond = 11;
  elements.ticketBoard.dataset.drawStartedAt = String(startedAt);

  elements.drawStage.classList.add("is-drawing");
  elements.ticketBoard.classList.add("is-drawing");
  elements.drawMessage.textContent = `${tier.slots} winning ticket${tier.slots === 1 ? "" : "s"} will remain lit`;
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

    flashVisibleTickets(tier.slots);
    playFlashTick(progress);
    const nextFlashDelay = 100 + Math.pow(progress, 2.5) * 900;
    await wait(Math.min(nextFlashDelay, remainingMs));
  }

  clearFlashingCells();
  stopCountdownMusic();
  elements.ticketBoard.dataset.drawCompletedAt = String(performance.now());
  elements.ticketBoard.classList.remove("is-drawing");
  elements.drawStage.classList.remove("is-drawing");
  elements.countdown.classList.remove("is-active");
  elements.countdownValue.textContent = "0.0";
  elements.drawMessage.textContent = `${winners.length} winning ticket${winners.length === 1 ? "" : "s"} confirmed`;
  playConfirmation();

}

async function handleDraw() {
  const tier = PRIZE_TIERS[state.tierIndex];
  const publicSeed = state.drawSeed.trim();
  if (!state.dataset || !tier || state.drawing || publicSeed === "") return;
  state.drawSeed = publicSeed;
  state.drawing = true;
  ensureAudioContext();
  playTierAnnouncement(tier);
  elements.broadcastStatus.classList.add("is-live");
  elements.broadcastStatus.querySelector("span").textContent = "LIVE DRAW";
  renderVisibleTicketGrid();
  render();

  try {
    const winners = await drawPrizeTier({
      tickets: state.dataset.tickets,
      tier,
      previousWinners: state.winners,
      publicSeed,
    });
    await runCountdown(winners, tier);
    const confirmedAt = new Date().toISOString();
    winners.forEach((winner) => {
      winner.drawnAt = confirmedAt;
    });
    state.winners.push(...winners);
    state.tierIndex += 1;
    state.drawnAt = confirmedAt;
    state.drawing = false;
    persistSession();
    if (state.tierIndex >= PRIZE_TIERS.length) {
      playVoice("complete");
    } else {
      playVoice(`done-${tier.key}`);
    }
    elements.broadcastStatus.classList.remove("is-live");
    elements.broadcastStatus.querySelector("span").textContent = "RESULTS CONFIRMED";
    renderVisibleTicketGrid();
    renderLatestWinners(winners, tier);
    render();
  } catch (error) {
    state.drawing = false;
    clearFlashingCells();
    stopCountdownMusic();
    elements.ticketBoard.classList.remove("is-drawing");
    elements.drawStage.classList.remove("is-drawing");
    elements.countdown.classList.remove("is-active");
    elements.broadcastStatus.classList.remove("is-live");
    elements.broadcastStatus.querySelector("span").textContent = "DRAW ERROR";
    elements.drawMessage.textContent = error instanceof Error ? error.message : "Unable to complete draw";
    render();
  }
}

function resetDraw() {
  if (state.winners.length > 0 && !window.confirm("Reset all draw results?")) return;
  state.winners.forEach((winner) => ticketElements.get(winner.ticketNumber)?.classList.remove("is-confirmed", "is-latest-winner"));
  clearFlashingCells();
  stopCountdownMusic();
  state.winners = [];
  state.tierIndex = 0;
  state.drawnAt = null;
  state.drawing = false;
  state.drawSeed = createRandomSeed();
  renderVisibleTicketGrid();
  elements.winnerStrip.innerHTML = "<p>Winning ticket numbers will appear here.</p>";
  elements.latestTier.textContent = "No result recorded";
  elements.broadcastStatus.classList.remove("is-live");
  elements.broadcastStatus.querySelector("span").textContent = "READY";
  elements.countdownValue.textContent = "10.0";
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
  link.download = `ticket-draw-results-${new Date().toISOString().slice(0, 10)}.csv`;
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

async function copyTierTickets(tier, winners, button) {
  if (winners.length === 0) return;
  const title = tier.label;
  const ticketNumbers = winners.map((winner) => `#${winner.ticketNumber}`).join(" ");
  await writeClipboard(`${title}\n${winners.length} winning ticket${winners.length === 1 ? "" : "s"}\n${ticketNumbers}`);
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
  playVoice(`randomize-${Math.floor(Math.random() * 5) + 1}`);
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
  introMusic.muted = !state.soundEnabled;
  if (state.soundEnabled) {
    ensureAudioContext();
    playTone({ frequency: 520, duration: 0.12, gain: 0.03, type: "triangle" });
  }
  render();
}

function toggleVoice() {
  state.voiceEnabled = !state.voiceEnabled;
  if (!state.voiceEnabled) {
    stopVoice();
  }
  render();
}

async function activateDataset() {
  setFeedback("Validating tickets");
  try {
    const response = await fetch("../../ticket-map.csv", { cache: "no-store" });
    if (!response.ok) throw new Error(`Ticket map unavailable (HTTP ${response.status})`);
    state.dataset = await validateTicketDataset(parseTicketCsv(await response.text()));
    renderTicketGrid();
    restoreSession();
    setFeedback(`${state.dataset.tickets.length.toLocaleString()} tickets verified`, "success");
  } catch (error) {
    setFeedback(error instanceof Error ? error.message : "Dataset validation failed", "error");
  }
  render();
}

elements.downloadButton.addEventListener("click", downloadResults);
elements.drawButton.addEventListener("click", () => void handleDraw());
elements.resetButton.addEventListener("click", resetDraw);
elements.seedInput.addEventListener("input", (event) => {
  state.drawSeed = event.currentTarget.value;
  render();
});
elements.rulesButton.addEventListener("click", playIntro);
elements.seedRandomizeButton.addEventListener("click", () => void randomizeSeed());
elements.seedCopyButton.addEventListener("click", (event) => void copySeed(event.currentTarget));
elements.soundButton.addEventListener("click", toggleSound);
elements.voiceButton.addEventListener("click", toggleVoice);
elements.drawStage.addEventListener("wheel", (event) => {
  if (elements.ticketBoard.contains(event.target) || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  elements.ticketBoard.scrollBy({ top: event.deltaY });
  event.preventDefault();
}, { passive: false });

render();
void activateDataset();
