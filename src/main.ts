import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

type SessionType = "work" | "short" | "long";

interface Settings {
  workMin: number;
  shortMin: number;
  longMin: number;
  cyclesBeforeLong: number;
  autoStart: boolean;
  sound: boolean;
  lockDuringFocus: boolean;
  blockingEnabled: boolean;
  blockList: string[];
}

interface DayRecord {
  pomodoros: number;
  focusMinutes: number;
}

type History = Record<string, DayRecord>;

const SETTINGS_KEY = "pomedoro:settings";
const HISTORY_KEY = "pomedoro:history";

const DEFAULT_SETTINGS: Settings = {
  workMin: 25,
  shortMin: 5,
  longMin: 15,
  cyclesBeforeLong: 4,
  autoStart: true,
  sound: true,
  lockDuringFocus: false,
  blockingEnabled: false,
  blockList: ["facebook.com", "twitter.com", "x.com", "instagram.com", "reddit.com", "tiktok.com", "youtube.com"],
};

const CIRCUMFERENCE_FULL = 2 * Math.PI * 90;
const CIRCUMFERENCE_MINI = 2 * Math.PI * 44;

// ---------- persistence ----------

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function todayKey(): string {
  return dateKey(new Date());
}

function loadHistory(): History {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveHistory() {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function todayRecord(): DayRecord {
  return history[todayKey()] ?? { pomodoros: 0, focusMinutes: 0 };
}

function recordCompletion(minutes: number) {
  const key = todayKey();
  const rec = history[key] ?? { pomodoros: 0, focusMinutes: 0 };
  rec.pomodoros++;
  rec.focusMinutes += minutes;
  history[key] = rec;
  saveHistory();
}

// ---------- state ----------

let settings = loadSettings();
let history = loadHistory();

let sessionType: SessionType = "work";
let completedInCycle = 0;
let remainingSeconds = durationFor(sessionType);
let running = false;
let endTimestamp = 0;
let tickHandle: number | undefined;
let audioCtx: AudioContext | null = null;
let notificationsReady = false;

function durationFor(type: SessionType): number {
  switch (type) {
    case "work":
      return settings.workMin * 60;
    case "short":
      return settings.shortMin * 60;
    case "long":
      return settings.longMin * 60;
  }
}

function nextSessionType(): SessionType {
  if (sessionType === "work") {
    completedInCycle++;
    return completedInCycle % settings.cyclesBeforeLong === 0 ? "long" : "short";
  }
  return "work";
}

// ---------- DOM refs ----------

const appEl = document.getElementById("app") as HTMLElement;
const compactEl = document.getElementById("compact") as HTMLElement;
const timeDisplay = document.getElementById("time-display") as HTMLElement;
const compactTime = document.getElementById("compact-time") as HTMLElement;
const sessionLabel = document.getElementById("session-label") as HTMLElement;
const ringProgress = document.getElementById("ring-progress") as unknown as SVGCircleElement;
const ringProgressMini = document.getElementById(
  "ring-progress-mini"
) as unknown as SVGCircleElement;
const statCount = document.getElementById("stat-count") as HTMLElement;
const statMinutes = document.getElementById("stat-minutes") as HTMLElement;
const flashOverlay = document.getElementById("flash-overlay") as HTMLElement;

const btnStart = document.getElementById("btn-start") as HTMLButtonElement;
const btnReset = document.getElementById("btn-reset") as HTMLButtonElement;
const btnSkip = document.getElementById("btn-skip") as HTMLButtonElement;
const btnPin = document.getElementById("btn-pin") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const btnCompact = document.getElementById("btn-compact") as HTMLButtonElement;
const btnHide = document.getElementById("btn-hide") as HTMLButtonElement;
const btnExpand = document.getElementById("btn-expand") as HTMLButtonElement;
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".session-tabs .tab"));

const settingsOverlay = document.getElementById("settings-overlay") as HTMLElement;
const btnSettingsCloseX = document.getElementById("btn-settings-close-x") as HTMLButtonElement;
const btnSettingsClose = document.getElementById("btn-settings-close") as HTMLButtonElement;
const btnSettingsSave = document.getElementById("btn-settings-save") as HTMLButtonElement;
const settingsTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-tab"));
const settingsPanels = Array.from(document.querySelectorAll<HTMLElement>(".settings-panel"));

const setWork = document.getElementById("set-work") as HTMLInputElement;
const setShort = document.getElementById("set-short") as HTMLInputElement;
const setLong = document.getElementById("set-long") as HTMLInputElement;
const setCycle = document.getElementById("set-cycle") as HTMLInputElement;
const setAutostart = document.getElementById("set-autostart") as HTMLInputElement;
const setSound = document.getElementById("set-sound") as HTMLInputElement;
const setLock = document.getElementById("set-lock") as HTMLInputElement;

const streakCurrent = document.getElementById("streak-current") as HTMLElement;
const streakBest = document.getElementById("streak-best") as HTMLElement;
const chartSvg = document.getElementById("chart-svg") as unknown as SVGSVGElement;
const periodTabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".period-tabs .tab"));

const setBlockingEnabled = document.getElementById("set-blocking-enabled") as HTMLInputElement;
const setBlockList = document.getElementById("set-block-list") as HTMLTextAreaElement;

const btnClose = document.getElementById("btn-close") as HTMLButtonElement;

const lockableControls = [btnStart, btnReset, btnSkip, btnHide, btnSettings, btnClose];

// ---------- rendering ----------

function currentRemaining(): number {
  if (running) {
    return Math.max(0, (endTimestamp - Date.now()) / 1000);
  }
  return remainingSeconds;
}

function formatTime(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateDisplay() {
  const remaining = currentRemaining();
  const total = durationFor(sessionType);
  const text = formatTime(remaining);

  timeDisplay.textContent = text;
  compactTime.textContent = text;
  document.title = running ? `${text} · Pomedoro` : "Pomedoro";

  const progress = total > 0 ? remaining / total : 0;
  ringProgress.style.strokeDashoffset = `${CIRCUMFERENCE_FULL * (1 - progress)}`;
  ringProgressMini.style.strokeDashoffset = `${CIRCUMFERENCE_MINI * (1 - progress)}`;
}

function updateStatsUI() {
  const today = todayRecord();
  statCount.textContent = String(today.pomodoros);
  statMinutes.textContent = String(today.focusMinutes);
}

const SESSION_LABELS: Record<SessionType, string> = {
  work: "Time to focus",
  short: "Short break",
  long: "Long break",
};

function applySessionUI() {
  appEl.dataset.session = sessionType;
  compactEl.dataset.session = sessionType;
  sessionLabel.textContent = SESSION_LABELS[sessionType];
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.session === sessionType));
}

function setStartLabel(label: "Start" | "Pause") {
  btnStart.textContent = label;
}

// While "lock" is on, every control that could interrupt a running session
// (pause, reset, skip, minimize, settings) is disabled until it finishes on
// its own. Only a hard app quit (tray menu) can end it early.
function isLocked(): boolean {
  return settings.lockDuringFocus && running && sessionType === "work";
}

function updateLockUI() {
  const locked = isLocked();
  lockableControls.forEach((btn) => {
    btn.disabled = locked;
  });
}

// ---------- distraction-site blocking ----------

// Tracks what we last told the Rust side, so we only ever call the elevated
// hosts-file command (which pops a UAC prompt) when the desired state
// actually changes - never on every timer tick or redundant transition.
let blockActive = false;

function syncBlocking() {
  const shouldBlock =
    settings.blockingEnabled && settings.blockList.length > 0 && running && sessionType === "work";
  if (shouldBlock === blockActive) return;
  const previous = blockActive;
  blockActive = shouldBlock;
  const call = shouldBlock
    ? invoke("enable_site_blocking", { domains: settings.blockList })
    : invoke("disable_site_blocking");
  call.catch(() => {
    blockActive = previous;
  });
}

// ---------- timer engine ----------

function tick() {
  if (!running) return;
  const remaining = currentRemaining();
  if (remaining <= 0) {
    onSessionComplete();
  } else {
    updateDisplay();
  }
}

function start() {
  if (running) return;
  running = true;
  endTimestamp = Date.now() + remainingSeconds * 1000;
  setStartLabel("Pause");
  tickHandle = window.setInterval(tick, 1000);
  updateDisplay();
  updateLockUI();
  syncBlocking();
}

function pause() {
  if (!running) return;
  remainingSeconds = Math.max(0, Math.round((endTimestamp - Date.now()) / 1000));
  running = false;
  if (tickHandle !== undefined) clearInterval(tickHandle);
  setStartLabel("Start");
  updateDisplay();
  updateLockUI();
  syncBlocking();
}

function toggleStartPause() {
  if (isLocked()) return;
  if (running) pause();
  else start();
}

function reset() {
  if (isLocked()) return;
  const wasRunning = running;
  if (wasRunning) {
    running = false;
    if (tickHandle !== undefined) clearInterval(tickHandle);
  }
  remainingSeconds = durationFor(sessionType);
  setStartLabel("Start");
  updateDisplay();
  updateLockUI();
  syncBlocking();
}

function skip() {
  if (isLocked()) return;
  const wasRunning = running;
  if (running) {
    running = false;
    if (tickHandle !== undefined) clearInterval(tickHandle);
  }
  sessionType = nextSessionType();
  remainingSeconds = durationFor(sessionType);
  applySessionUI();
  updateDisplay();
  if (wasRunning) start();
  else setStartLabel("Start");
  updateLockUI();
  syncBlocking();
}

function switchTo(type: SessionType) {
  if (isLocked()) return;
  if (type === sessionType) return;
  running = false;
  if (tickHandle !== undefined) clearInterval(tickHandle);
  sessionType = type;
  remainingSeconds = durationFor(sessionType);
  applySessionUI();
  updateDisplay();
  setStartLabel("Start");
  updateLockUI();
  syncBlocking();
}

function onSessionComplete() {
  running = false;
  if (tickHandle !== undefined) clearInterval(tickHandle);

  const finishedType = sessionType;
  if (finishedType === "work") {
    recordCompletion(settings.workMin);
    updateStatsUI();
  }

  celebrate(finishedType);

  sessionType = nextSessionType();
  remainingSeconds = durationFor(sessionType);
  applySessionUI();
  updateDisplay();

  if (settings.autoStart) start();
  else setStartLabel("Start");
  updateLockUI();
  syncBlocking();
}

// ---------- completion effects ----------

function playChime() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    const notes = [880, 1174.66];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.16;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.42);
    });
  } catch {
    /* audio not available; ignore */
  }
}

function flashScreen() {
  flashOverlay.classList.remove("flashing");
  // force reflow so the animation restarts if it's already running
  void flashOverlay.offsetWidth;
  flashOverlay.classList.add("flashing");
  setTimeout(() => flashOverlay.classList.remove("flashing"), 1700);
}

async function notifyCompletion(finishedType: SessionType) {
  if (!notificationsReady) return;
  const title = finishedType === "work" ? "Focus session complete" : "Break's over";
  const body =
    finishedType === "work" ? "Nice work! Time for a break." : "Ready to focus again?";
  try {
    sendNotification({ title, body });
  } catch {
    /* notification failed; visual/audio alerts still fired */
  }
}

function celebrate(finishedType: SessionType) {
  if (settings.sound) playChime();
  flashScreen();
  invoke("flash_window").catch(() => {});
  notifyCompletion(finishedType);
}

// ---------- window controls ----------

let pinned = true;

async function togglePin() {
  pinned = !pinned;
  btnPin.classList.toggle("active", pinned);
  try {
    await invoke("set_always_on_top", { value: pinned });
  } catch {
    /* ignore */
  }
}

async function enterCompact() {
  appEl.classList.add("hidden");
  compactEl.classList.remove("hidden");
  try {
    await invoke("toggle_compact", { compact: true });
  } catch {
    /* ignore */
  }
}

async function exitCompact() {
  compactEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  try {
    await invoke("toggle_compact", { compact: false });
  } catch {
    /* ignore */
  }
}

async function minimizeToTray() {
  try {
    await invoke("hide_window");
  } catch {
    /* ignore */
  }
}

// ---------- settings modal ----------

function openSettings() {
  setWork.value = String(settings.workMin);
  setShort.value = String(settings.shortMin);
  setLong.value = String(settings.longMin);
  setCycle.value = String(settings.cyclesBeforeLong);
  setAutostart.checked = settings.autoStart;
  setSound.checked = settings.sound;
  setLock.checked = settings.lockDuringFocus;
  setBlockingEnabled.checked = settings.blockingEnabled;
  setBlockList.value = settings.blockList.join("\n");
  switchSettingsTab("general");
  settingsOverlay.classList.remove("hidden");
}

function closeSettings() {
  settingsOverlay.classList.add("hidden");
}

function switchSettingsTab(tabName: string) {
  settingsTabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
  settingsPanels.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tabName));
  if (tabName === "insights") {
    updateStreaksUI();
    renderChart(currentPeriod);
  }
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function saveSettingsFromModal() {
  settings.workMin = clamp(parseInt(setWork.value, 10), 1, 180);
  settings.shortMin = clamp(parseInt(setShort.value, 10), 1, 60);
  settings.longMin = clamp(parseInt(setLong.value, 10), 1, 120);
  settings.cyclesBeforeLong = clamp(parseInt(setCycle.value, 10), 2, 12);
  settings.autoStart = setAutostart.checked;
  settings.sound = setSound.checked;
  settings.lockDuringFocus = setLock.checked;
  settings.blockingEnabled = setBlockingEnabled.checked;
  settings.blockList = setBlockList.value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  saveSettings();

  if (!running) {
    remainingSeconds = durationFor(sessionType);
    updateDisplay();
  }
  updateLockUI();
  syncBlocking();
  closeSettings();
}

// ---------- insights: history buckets, streaks, chart ----------

type Period = "day" | "week" | "month";
let currentPeriod: Period = "day";

const SVG_NS = "http://www.w3.org/2000/svg";

interface Bucket {
  label: string;
  minutes: number;
}

function dayBuckets(count: number): Bucket[] {
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push({
      label: d.toLocaleDateString(undefined, { weekday: "narrow" }),
      minutes: history[dateKey(d)]?.focusMinutes ?? 0,
    });
  }
  return out;
}

function weekBuckets(count: number): Bucket[] {
  const out: Bucket[] = [];
  for (let w = count - 1; w >= 0; w--) {
    let total = 0;
    let weekStart = new Date();
    for (let d = 0; d < 7; d++) {
      const day = new Date();
      day.setDate(day.getDate() - (w * 7 + d));
      if (d === 6) weekStart = day;
      total += history[dateKey(day)]?.focusMinutes ?? 0;
    }
    out.push({
      label: weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      minutes: total,
    });
  }
  return out;
}

function monthBuckets(count: number): Bucket[] {
  const out: Bucket[] = [];
  const now = new Date();
  for (let m = count - 1; m >= 0; m--) {
    const ref = new Date(now.getFullYear(), now.getMonth() - m, 1);
    let total = 0;
    for (const key in history) {
      const kd = new Date(`${key}T00:00:00`);
      if (kd.getFullYear() === ref.getFullYear() && kd.getMonth() === ref.getMonth()) {
        total += history[key].focusMinutes;
      }
    }
    out.push({ label: ref.toLocaleDateString(undefined, { month: "short" }), minutes: total });
  }
  return out;
}

// Rounded top corners, square baseline - per the bar mark spec (4px data-end,
// square where the bar meets the axis).
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y} L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius} L${x + w},${y + h} Z`;
}

function renderChart(period: Period) {
  const buckets =
    period === "day" ? dayBuckets(7) : period === "week" ? weekBuckets(8) : monthBuckets(6);

  const width = 280;
  const height = 140;
  const paddingBottom = 22;
  const paddingTop = 10;
  const chartHeight = height - paddingBottom - paddingTop;
  const maxVal = Math.max(...buckets.map((b) => b.minutes), 1);
  const slot = width / buckets.length;
  const barWidth = Math.min(24, slot - 8);

  while (chartSvg.firstChild) chartSvg.removeChild(chartSvg.firstChild);
  chartSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const baseline = document.createElementNS(SVG_NS, "line");
  baseline.setAttribute("x1", "0");
  baseline.setAttribute("x2", String(width));
  baseline.setAttribute("y1", String(height - paddingBottom));
  baseline.setAttribute("y2", String(height - paddingBottom));
  baseline.setAttribute("class", "chart-baseline");
  chartSvg.appendChild(baseline);

  buckets.forEach((b, i) => {
    const barHeight = maxVal > 0 ? Math.max(1, (b.minutes / maxVal) * chartHeight) : 1;
    const x = i * slot + (slot - barWidth) / 2;
    const y = height - paddingBottom - barHeight;

    const bar = document.createElementNS(SVG_NS, "path");
    bar.setAttribute("d", barPath(x, y, barWidth, barHeight, 4));
    bar.setAttribute("class", "chart-bar");

    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${b.label}: ${b.minutes} min`;
    bar.appendChild(title);
    chartSvg.appendChild(bar);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(i * slot + slot / 2));
    label.setAttribute("y", String(height - 6));
    label.setAttribute("class", "chart-axis-label");
    label.setAttribute("text-anchor", "middle");
    label.textContent = b.label;
    chartSvg.appendChild(label);
  });
}

function computeStreaks(): { current: number; best: number } {
  const activeDates = Object.keys(history).filter((k) => history[k].pomodoros > 0);
  if (activeDates.length === 0) return { current: 0, best: 0 };
  const dateSet = new Set(activeDates);

  let current = 0;
  const cursor = new Date();
  if (!dateSet.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (dateSet.has(dateKey(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const sorted = activeDates.slice().sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of sorted) {
    const d = new Date(`${key}T00:00:00`);
    if (prev) {
      const diffDays = Math.round((d.getTime() - prev.getTime()) / 86400000);
      run = diffDays === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    prev = d;
  }

  return { current, best: Math.max(best, current) };
}

function updateStreaksUI() {
  const { current, best } = computeStreaks();
  streakCurrent.textContent = String(current);
  streakBest.textContent = String(best);
}

// ---------- wiring ----------

function init() {
  applySessionUI();
  updateDisplay();
  updateStatsUI();
  setStartLabel("Start");
  updateLockUI();

  btnStart.addEventListener("click", toggleStartPause);
  btnReset.addEventListener("click", reset);
  btnSkip.addEventListener("click", skip);
  btnPin.addEventListener("click", togglePin);
  btnSettings.addEventListener("click", () => openSettings());
  btnCompact.addEventListener("click", enterCompact);
  btnExpand.addEventListener("click", exitCompact);
  btnHide.addEventListener("click", minimizeToTray);
  btnClose.addEventListener("click", () => {
    invoke("quit_app").catch(() => {});
  });

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTo(tab.dataset.session as SessionType));
  });

  periodTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      currentPeriod = tab.dataset.period as Period;
      periodTabs.forEach((t) => t.classList.toggle("active", t === tab));
      renderChart(currentPeriod);
    });
  });

  settingsTabs.forEach((tab) => {
    tab.addEventListener("click", () => switchSettingsTab(tab.dataset.tab as string));
  });

  btnSettingsCloseX.addEventListener("click", closeSettings);
  btnSettingsClose.addEventListener("click", closeSettings);
  btnSettingsSave.addEventListener("click", saveSettingsFromModal);
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSettings();
  });

  document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";

    if (e.key === "Escape" && !settingsOverlay.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (e.key === " " && !typing) {
      e.preventDefault();
      toggleStartPause();
    }
  });

  isPermissionGranted()
    .then((granted) => {
      if (granted) {
        notificationsReady = true;
        return;
      }
      return requestPermission().then((perm) => {
        notificationsReady = perm === "granted";
      });
    })
    .catch(() => {
      notificationsReady = false;
    });
}

init();
