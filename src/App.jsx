// App.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { listSongs, saveSong, loadSongBytes, removeSong } from "./db";

/**
 * Falling Notes Piano – 視認性UP & 教育特化版（安定化＋エラーハンドリング強化）
 * + 生成（MVP）：キー/長短/テンポ/小節/難易度 を指定してメロディをクライアント生成
 */

const KEY_COUNT = 88;
const A0_MIDI = 21;
const C8_MIDI = A0_MIDI + KEY_COUNT - 1;
const MIDDLE_C = 60;

const MIN_VISIBLE_KEYS = 48;   // 最小表示鍵数（最大ズーム）
const MAX_VISIBLE_KEYS = KEY_COUNT; // 既存の上限そのまま

const NOTE_MIN_HEIGHT = 10;
const SPEED = 140;     // px/sec
const KB_HEIGHT = 100; // keyboard height (px) - reduced for better visibility
const VISUAL_MAX_SEC = 2.5; // 表示上の最大長（音は実長で鳴らす）
const STOP_TAIL = 1.0; // 自動停止の安全マージン（秒）

const FLASH_MS = 120;
const MIN_LIT_SEC = 0.12;
const VISUAL_MERGE_GAP = 0.06;

const WHITE_KEYS_PATTERN = [true,false,true,false,true,true,false,true,false,true,false,true];
const isWhite = (m)=>WHITE_KEYS_PATTERN[m%12];
const clamp = (v,a,b)=>Math.max(a, Math.min(b, v));

const timeToY = (tNow, tt) => (tNow - tt) * SPEED;
const timeToYTop = (tNow, noteStart, _totalVisual, height = NOTE_MIN_HEIGHT) =>
  timeToY(tNow, noteStart) - height;

const COLORS = {
  bg: "#0b1219",
  grid: "#13202b",
  whiteKey: "#fafafa",
  blackKey: "#2b2f36",
  keyBorder: "#cfd4da",
  keyShadow: "rgba(0,0,0,0.4)",
  noteWhite: "#4fb0ff",
  noteWhiteActive: "#7fc9ff",
  noteBlack: "#ff6b6b",
  noteBlackActive: "#ff8d8d",
  keyActiveWhite: "#9ad1ff",
  keyActiveBlack: "#ff8d8d",
  text: "#e7eef7",
  particleWhite: "#bde3ff",
  particleBlack: "#ffc5c5",
  trailWhite: "rgb(135,206,235)",
  trailBlack: "rgb(255,160,122)",
  markerC: "#7dd3fc",
  markerC4: "#fbbf24",
  fadeEdge: "rgba(0,0,0,0.45)",
  label: "#334155",
};

const FAST_FRAME_INTERVAL = 1000 / 60;
const MEDIUM_FRAME_INTERVAL = 1000 / 30;
const SLOW_FRAME_INTERVAL = 1000 / 15;

const DevStatsOverlay = React.memo(function DevStatsOverlay({ visible, fps, drops }) {
  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed bottom-3 left-3 rounded bg-emerald-900/70 px-2 py-1 text-[11px] font-mono text-emerald-200 shadow-lg">
      <div>fps: {fps.toFixed(1)}</div>
      <div>drops: {drops.toFixed(1)}/s</div>
    </div>
  );
});

function addRoundedRectPath(ctx, x, y, w, h) {
  const r = Math.min(6, w * 0.3);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


// key proportions & skin
const BLACK_W_RATIO = 0.66;   // 黒鍵の横幅（白鍵比）
const BLACK_H_RATIO = 0.62;   // 黒鍵の縦の長さ（鍵盤高さ比）
const KEY_RADIUS     = 6;

function drawRoundedRect(ctx, x, y, w, h, r = KEY_RADIUS) {
  addRoundedRectPath(ctx, x, y, w, h);
}

function drawWhiteKey(ctx, x, y, w, h, active = false) {
  // base subtle gradient
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, "#f7f9fb");
  g.addColorStop(0.5, "#eef2f7");
  g.addColorStop(1, "#e3e8ef");
  ctx.fillStyle = g;
  ctx.beginPath();
  drawRoundedRect(ctx, x, y, w - 1, h, 5);
  ctx.fill();

  // side inner shading
  const side = ctx.createLinearGradient(x, y, x + w, y);
  side.addColorStop(0.0, "rgba(0,0,0,0.10)");
  side.addColorStop(0.08, "rgba(0,0,0,0.00)");
  side.addColorStop(0.92, "rgba(0,0,0,0.00)");
  side.addColorStop(1.0, "rgba(0,0,0,0.10)");
  ctx.fillStyle = side;
  ctx.fillRect(x, y, w - 1, h);

  // top gloss
  const gloss = ctx.createLinearGradient(x, y, x, y + h * 0.28);
  gloss.addColorStop(0, active ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.65)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(x + 1, y + 1, w - 3, h * 0.28);

  // outer border
  ctx.strokeStyle = "#cfd4da";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 2, h - 1);
}

function drawBlackKey(ctx, x, y, w, h, active = false) {
  // deep glossy body
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, active ? "#1b1e23" : "#171a1f");
  g.addColorStop(0.6, active ? "#2b3036" : "#262b31");
  g.addColorStop(1, active ? "#30353c" : "#2c3138");
  ctx.fillStyle = g;
  ctx.beginPath();
  drawRoundedRect(ctx, x, y, w, h, 4);
  ctx.fill();

  // top gloss strip
  const gloss = ctx.createLinearGradient(x, y, x, y + h);
  gloss.addColorStop(0.0, "rgba(255,255,255,0.20)");
  gloss.addColorStop(0.15, "rgba(255,255,255,0.06)");
  gloss.addColorStop(0.35, "rgba(255,255,255,0.00)");
  ctx.fillStyle = gloss;
  ctx.fillRect(x + 1, y + 1, w - 2, h * 0.45);

  // edge
  ctx.strokeStyle = "rgba(0,0,0,0.60)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}


function getNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

// ---------- utilities ----------
function mergeConsecutiveNotes(notes, gap=VISUAL_MERGE_GAP){
  if(!notes.length) return [];
  const out = [];
  const byPitch = new Map();
  for(const n of notes){
    if(!byPitch.has(n.midi)) byPitch.set(n.midi, []);
    byPitch.get(n.midi).push(n);
  }
  for(const arr of byPitch.values()){
    arr.sort((a,b)=>a.start-b.start);
    let cur = {...arr[0]};
    for(let i=1;i<arr.length;i++){
      const nxt = arr[i];
      const g = nxt.start - cur.end;
      if(g <= gap && g >= -0.001){
        cur.end = Math.max(cur.end, nxt.end);
        cur.vel = Math.max(cur.vel, nxt.vel);
      }else{
        out.push(cur);
        cur = {...nxt};
      }
    }
    out.push(cur);
  }
  out.sort((a,b)=>a.start-b.start);
  return out.map((n,i)=>({...n, i}));
}

async function createSynthChain(){
  const inst = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "triangle" },
    envelope: { attack: 0.005, decay: 0.1, sustain: 0.2, release: 0.8 }
  });
  return { inst, chain: [inst] };
}

async function createPianoChain(bright=false){
  const sampler = new Tone.Sampler({
    urls: {
      A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
      A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
      A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
      A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
      A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
      A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
      A7: "A7.mp3", C8: "C8.mp3"
    },
    release: 1,
    baseUrl: "https://tonejs.github.io/audio/salamander/"
  });
  await sampler.loaded;

  const chain = [sampler];
  if(bright){
    const eq = new Tone.EQ3({ low: -1, mid: 0, high: 2 });
    const rev = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000, wet: 0.12 });
    sampler.chain(eq, rev);
    chain.push(eq, rev);
  }else{
    const rev = new Tone.Freeverb({ roomSize: 0.65, dampening: 2600, wet: 0.08 });
    sampler.chain(rev);
    chain.push(rev);
  }
  return { inst: sampler, chain };
}

// label helpers
function nameAG(midi){
  const names = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const n = names[midi % 12];
  const octave = Math.floor(midi/12) - 1;
  return { name: n, octave };
}
function nameDoReMi(midi){
  const map = { "C":"ド","D":"レ","E":"ミ","F":"ファ","G":"ソ","A":"ラ","B":"シ" };
  const { name } = nameAG(midi);
  const base = name.replace("#","♯");
  const kana = map[base.replace("♯","")] ?? base;
  return { name: base.includes("♯") ? `${kana}♯` : kana, octave: Math.floor(midi/12) - 1 };
}

// range helpers
const clampMidi = (m)=>clamp(m, A0_MIDI, C8_MIDI);
function centerPresetRange(centerMidi, keyCount){
  const span = clamp(Math.round(keyCount), MIN_VISIBLE_KEYS, MAX_VISIBLE_KEYS);
  const clampedCenter = clampMidi(centerMidi);
  const half = Math.floor((span - 1) / 2);
  let min = clampedCenter - half;
  let max = min + span - 1;

  if (min < A0_MIDI) {
    min = A0_MIDI;
    max = min + span - 1;
  }
  if (max > C8_MIDI) {
    max = C8_MIDI;
    min = max - span + 1;
  }

  min = clampMidi(min);
  max = clampMidi(max);

  // 端で切れた場合でも span を維持
  if (max - min + 1 < span) {
    if (min === A0_MIDI) {
      max = clampMidi(min + span - 1);
    } else if (max === C8_MIDI) {
      min = clampMidi(max - span + 1);
    }
  }

  return { minMidi:min, maxMidi:max };
}
function normalizeVisibleRange(minMidi, maxMidi, desiredSpan = MIN_VISIBLE_KEYS){
  let min = clampMidi(Math.min(minMidi, maxMidi));
  let max = clampMidi(Math.max(minMidi, maxMidi));
  const span = max - min + 1;
  if(span < desiredSpan){
    const center = Math.round((min + max) / 2);
    return centerPresetRange(center, desiredSpan);
  }
  if(span > MAX_VISIBLE_KEYS){
    const center = Math.round((min + max) / 2);
    return centerPresetRange(center, MAX_VISIBLE_KEYS);
  }
  return { minMidi:min, maxMidi:max };
}
function analyzeNoteRangeAuto(notes){
  if(!notes.length) return { minMidi:A0_MIDI, maxMidi:C8_MIDI };
  let min=Infinity, max=-Infinity;
  for(const n of notes){ if(n.midi<min) min=n.midi; if(n.midi>max) max=n.midi; }
  min = clampMidi(min-3); max = clampMidi(max+3);
  return normalizeVisibleRange(min, max);
}

// ---------- particles / ripples / aura ----------
function spawnParticles(store, {x,y,color}, level){
  let count, sizeMin, sizeMax, sparkleProb;
  
  switch(level) {
    case 'standard':
      count = 8; sizeMin = 2; sizeMax = 5; sparkleProb = 0;
      break;
    case 'fun-refined': // 洗練版
      count = 6; sizeMin = 3; sizeMax = 6; sparkleProb = 0.30;
      break;
    case 'fun-elegant': // エレガント
      count = 4; sizeMin = 2; sizeMax = 4; sparkleProb = 0;
      break;
    case 'fun-colorful': // カラフル
      count = 10; sizeMin = 3; sizeMax = 7; sparkleProb = 1.0;
      break;
    case 'fun-original': // オリジナル
      count = 14; sizeMin = 2; sizeMax = 5; sparkleProb = 0.35;
      break;
    default:
      count = 6; sizeMin = 3; sizeMax = 6; sparkleProb = 0.30;
  }
  
  for(let i=0;i<count;i++){
    const ang = Math.random()*Math.PI - Math.PI/2;
    const speed = 60 + Math.random()*120;
    store.push({
      x,y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed-40,
      life: 0.5 + Math.random()*0.4, age:0,
      color, size: sizeMin + Math.random()*(sizeMax-sizeMin),
      sparkle: Math.random() < sparkleProb
    });
  }
}

function spawnRipple(store, {x,y}, level){
  let count, maxRadius;
  
  switch(level) {
    case 'standard':
      count = 1; maxRadius = 90;
      break;
    case 'fun-refined': // 洗練版
      count = 1; maxRadius = 100;
      break;
    case 'fun-elegant': // エレガント
      count = 1; maxRadius = 80;
      break;
    case 'fun-colorful': // カラフル
      count = 3; maxRadius = 120;
      break;
    case 'fun-original': // オリジナル
      count = 2; maxRadius = 130;
      break;
    default:
      count = 1; maxRadius = 100;
  }
  
  for(let i=0;i<count;i++){
    store.push({ x,y, radius:5, maxRadius, life:1.2, age:0, alpha:0.7, delay:i*0.1 });
  }
}

export default function App(){
  const canvasRef = useRef(null);

  // data
  const [notes, setNotes] = useState([]);
  const [name, setName] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [duration, setDuration] = useState(0);
  const durationRef = useRef(0); // 実長（停止判定用）
  const [visualEnd, setVisualEnd] = useState(0);
  const endTimeRef = useRef(Infinity); // 視覚的な終了時刻（即時反映）

  const [rate, setRate] = useState(1);
  const rateRef = useRef(1);

  const [sound, setSound] = useState("piano");
  const [soundLoading, setSoundLoading] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [instReady, setInstReady] = useState(false);

  const [noteStyle, setNoteStyle] = useState("note-jp");
  const [effectLevel, setEffectLevel] = useState("fun-refined"); // focus | standard | fun-refined | fun-elegant | fun-colorful | fun-original
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [labelMode, setLabelMode] = useState("none"); // none | AG | DoReMi

  // --- UI状態 ---
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  const [rangePreset, setRangePreset] = useState("auto");
  const [viewMinMidi, setViewMinMidi] = useState(A0_MIDI);
  const [viewMaxMidi, setViewMaxMidi] = useState(C8_MIDI);

  // --- 生成パラメータ（MVP） ---
  const [genKey, setGenKey] = useState("C");             // C,D,E,F,G,A,B
  const [genScale, setGenScale] = useState("major");     // major | minor
  const [genTempo, setGenTempo] = useState(90);          // bpm
  const [genBars, setGenBars] = useState(4);             // 小節数
  const [genDifficulty, setGenDifficulty] = useState(0); // 0..3
  const [genType, setGenType] = useState("random");      // random | twinkle | butterfly

  // --- A-Bリピート機能 ---
  const [abRepeatEnabled, setAbRepeatEnabled] = useState(false);
  const [abRepeatA, setAbRepeatA] = useState(null);
  const [abRepeatB, setAbRepeatB] = useState(null);
  const abRepeatARef = useRef(null);
  const abRepeatBRef = useRef(null);
  const abRepeatEnabledRef = useRef(false);

  // --- シーク操作中フラグ ---
  const [isSeeking, setIsSeeking] = useState(false);
  const isSeekingRef = useRef(false);
  const wasPlayingBeforeSeek = useRef(false);

  // library UI
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState([]);

  // offline / diagnostics
  const [isOfflineMode, setIsOfflineMode] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false
  );
  const [offlineReady, setOfflineReady] = useState(false);
  const [offlineStatusDetail, setOfflineStatusDetail] = useState(null);
  const [precacheState, setPrecacheState] = useState({ status: "idle" });
  const [updateToast, setUpdateToast] = useState(null);
  const [swVersion, setSwVersion] = useState(null);
  const [devPanelOpen, setDevPanelOpen] = useState(false);
  const [cacheReport, setCacheReport] = useState([]);
  const [purgeState, setPurgeState] = useState(null);
  const [cacheError, setCacheError] = useState(null);
  const [frameStats, setFrameStats] = useState({ fps: 0, drops: 0 });
  const controllerSeenRef = useRef(
    typeof navigator !== "undefined" ? Boolean(navigator.serviceWorker?.controller) : false
  );

  const isDevEnvironment = import.meta.env?.DEV ?? false;

  // 可視窓
  const noteStartsRef = useRef([]);
  const lowerBound = (arr, x) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  useEffect(() => { noteStartsRef.current = notes.map(n => n.start); }, [notes]);

  useEffect(() => {
    loopEnabledRef.current = loopEnabled;
  }, [loopEnabled]);

  useEffect(() => {
    abRepeatEnabledRef.current = abRepeatEnabled;
    abRepeatARef.current = abRepeatA;
    abRepeatBRef.current = abRepeatB;
  }, [abRepeatEnabled, abRepeatA, abRepeatB]);

  useEffect(() => {
    devPanelOpenRef.current = devPanelOpen;
    if (devPanelOpen) {
      setFrameStats(frameStatsLatestRef.current);
    }
  }, [devPanelOpen]);


useEffect(() => {
  const ua = (typeof navigator !== "undefined" && (navigator.userAgent || "")) || "";
  // ゆるめの判定：iPad かつ古めの OS / 旧世代機っぽい場合
  const looksOldiPad =
    /iPad/i.test(ua) && (/(OS 1[2-4]_|\bCPU OS 1[2-4]_)/i.test(ua) || /A10|A10X|A9|A8/i.test(ua));
  Tone.Transport.scheduleAheadTime = looksOldiPad ? 0.38 : 0.22;
}, []);


  // timing
  const playheadRef = useRef(0);
  const t0Ref = useRef(0);
  const rafIdRef = useRef(0);
  const rafActiveRef = useRef(false);
  const isPlayingRef = useRef(false);
  const prevTRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const frameIntervalRef = useRef(FAST_FRAME_INTERVAL);
  const frameBoostUntilRef = useRef(0);
  const forceFrameRef = useRef(false);
  const lastUiUpdateRef = useRef(0);
  const loopEnabledRef = useRef(false);
  const frameStatsRef = useRef({ lastSample: 0, frames: 0, skipped: 0 });
  const frameStatsLatestRef = useRef({ fps: 0, drops: 0 });
  const devPanelOpenRef = useRef(false);

  // audio
  const masterRef = useRef(null);
  const busRef = useRef(null);
  const instrumentRef = useRef(null);

  async function ensureAudioReady() {
    try {

      await Tone?.start?.();
      await Tone?.getContext?.()?.rawContext?.resume?.();
      console.log("[audio] unlocked");
      return true;
    } catch (e) {
      console.warn("[audio] unlock failed:", e);
      return false;

    }
  }

  const requestFrameBoost = useCallback((duration = 1200) => {
    const now = getNow();
    frameBoostUntilRef.current = now + duration;
    frameIntervalRef.current = FAST_FRAME_INTERVAL;
    forceFrameRef.current = true;
  }, []);

  const syncUiPlayhead = useCallback(
    (value, { force = false, timestamp } = {}) => {
      const now = timestamp ?? getNow();
      if (force) {
        lastUiUpdateRef.current = now;
        setPlayhead(value);
        return;
      }
      if (now - lastUiUpdateRef.current >= 100) {
        lastUiUpdateRef.current = now;
        setPlayhead(value);
      }
    },
    [setPlayhead]
  );

  const recordFrame = useCallback(
    (timestamp, drawn) => {
      const stats = frameStatsRef.current;
      if (!stats.lastSample) {
        stats.lastSample = timestamp;
      }
      if (drawn) stats.frames += 1; else stats.skipped += 1;
      const elapsed = timestamp - stats.lastSample;
      if (elapsed >= 1000) {
        const fps = (stats.frames * 1000) / elapsed;
        const drops = (stats.skipped * 1000) / elapsed;
        const snapshot = { fps, drops };
        frameStatsLatestRef.current = snapshot;
        if (devPanelOpenRef.current) {
          setFrameStats(snapshot);
        }
        stats.frames = 0;
        stats.skipped = 0;
        stats.lastSample = timestamp;
      }
    },
    [setFrameStats]
  );

  function resetVisualState() {
    keyFlashRef.current.clear();
    landedAtRef.current.clear();
    particlesRef.current = [];
    ripplesRef.current = [];
    trailsRef.current.clear();
    aurasRef.current = [];
    bgIntensityRef.current = 0;
  }

  function determineFrameInterval(metrics) {
    if (!isPlayingRef.current) return FAST_FRAME_INTERVAL;
    if (!metrics) return FAST_FRAME_INTERVAL;
    if (metrics.drawnNotes <= 0) return SLOW_FRAME_INTERVAL;
    if (metrics.drawnNotes < 6 && metrics.nearKeyline < 2) return MEDIUM_FRAME_INTERVAL;
    return FAST_FRAME_INTERVAL;

  }

  // hit state
  const keyFlashRef = useRef(new Map()); // midi -> until(sec)
  const landedAtRef = useRef(new Map()); // noteId -> t

  // visuals
  const particlesRef = useRef([]);
  const ripplesRef = useRef([]);
  const trailsRef = useRef(new Map());
  const aurasRef = useRef([]);
  const bgIntensityRef = useRef(0);

  const refreshOfflineStatus = useCallback(async () => {
    if (typeof window === "undefined") return;
    try {
      const status = await window.__fnpwa?.checkOfflineReady?.();
      if (status) {
        setOfflineReady(Boolean(status.ok));
        setOfflineStatusDetail(status);
      }
    } catch (err) {
      console.warn("[FNPWA] checkOfflineReady failed", err);
      setOfflineReady(false);
      setOfflineStatusDetail({ ok: false, error: String(err) });
    }
  }, []);

  const refreshCacheReport = useCallback(async () => {
    if (typeof window === "undefined") return;
    try {
      const report = await window.__fnpwa?.debug?.listCaches?.();
      if (report) {
        setCacheReport(report);
        setCacheError(null);
      }
    } catch (err) {
      console.warn("[FNPWA] listCaches failed", err);
      setCacheReport([]);
      setCacheError(String(err));
    }
  }, []);

  const handleManualPrecache = useCallback(async () => {
    if (typeof window === "undefined" || !window.__fnpwa?.precache) {
      return;
    }
    setPrecacheState({ status: "running" });
    try {

      await window.__fnpwa?.collectAssetHints?.();

      const essentials = [
        "/",
        "/index.html",
        "/manifest.webmanifest",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/maskable-512.png",
      ];
      const assetHints = window.__fnpwa?.assetHints || [];
      const result = await window.__fnpwa.precache([...essentials, ...assetHints]);
      setPrecacheState({ status: result?.ok ? "done" : "error", detail: result });
    } catch (err) {
      setPrecacheState({ status: "error", detail: { error: String(err) } });
    }
    await refreshOfflineStatus();
    await refreshCacheReport();
  }, [refreshCacheReport, refreshOfflineStatus]);

  const handlePurgeCaches = useCallback(async () => {
    if (typeof window === "undefined" || !window.__fnpwa?.debug?.purgeAll) {
      return;
    }
    setPurgeState({ status: "running" });
    try {
      const result = await window.__fnpwa.debug.purgeAll();
      setPurgeState({ status: "done", detail: result });
    } catch (err) {
      setPurgeState({ status: "error", detail: { error: String(err) } });
    }
    await refreshOfflineStatus();
    await refreshCacheReport();
  }, [refreshCacheReport, refreshOfflineStatus]);

  const handleUpdateNow = useCallback(() => {
    if (typeof window === "undefined") return;
    setUpdateToast({ status: "applying" });
    window.__fnpwa?.applyUpdate?.();
  }, []);

  const dismissUpdateToast = useCallback(() => {
    setUpdateToast(null);
  }, []);

  // size cache
  const canvasSizeRef = useRef({ W:0, H:0 });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setIsOfflineMode(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    (async () => {
      await refreshOfflineStatus();
      const info = await window.__fnpwa?.debug?.swInfo?.();
      if (!cancelled && info?.version) {
        setSwVersion(info.version);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshOfflineStatus]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onWaiting = () => setUpdateToast({ status: "ready" });
    const onRegistered = () => {
      window.__fnpwa?.requestOfflineStatus?.().catch(() => {});
    };
    const onAssetHints = () => {
      if (devPanelOpen) refreshCacheReport();
    };
    const onMessage = (event) => {
      const payload = event.detail;
      if (!payload) return;
      if (payload.type === "OFFLINE_STATUS") {
        if (payload.status) {
          setOfflineReady(Boolean(payload.status.ok));
          setOfflineStatusDetail(payload.status);
          if (payload.status.version) setSwVersion(payload.status.version);
        }
      } else if (payload.type === "PRECACHE_RESULT") {
        const result = payload.result || payload;
        setPrecacheState({ status: result?.ok ? "done" : "error", detail: result });
        refreshOfflineStatus();
        refreshCacheReport();
      } else if (payload.type === "SW_VERSION") {
        if (payload.version) setSwVersion(payload.version);
      }
    };

    window.addEventListener("fnpwa:sw-waiting", onWaiting);
    window.addEventListener("fnpwa:sw-registered", onRegistered);
    window.addEventListener("fnpwa:asset-hints", onAssetHints);
    window.addEventListener("fnpwa:sw-message", onMessage);
    return () => {
      window.removeEventListener("fnpwa:sw-waiting", onWaiting);
      window.removeEventListener("fnpwa:sw-registered", onRegistered);
      window.removeEventListener("fnpwa:asset-hints", onAssetHints);
      window.removeEventListener("fnpwa:sw-message", onMessage);
    };
  }, [devPanelOpen, refreshCacheReport, refreshOfflineStatus]);

  useEffect(() => {
    if (!devPanelOpen) return;

    window.__fnpwa?.collectAssetHints?.();

    refreshCacheReport();
  }, [devPanelOpen, refreshCacheReport]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      if (!controllerSeenRef.current) {
        controllerSeenRef.current = true;
        return;
      }
      window.location.reload();
    };
    window.addEventListener("fnpwa:controllerchange", handler);
    return () => window.removeEventListener("fnpwa:controllerchange", handler);
  }, []);

  useEffect(() => {
    if (!isOfflineMode) {
      refreshOfflineStatus();
    }
  }, [isOfflineMode, refreshOfflineStatus]);

  // ====== 初期化：バスのみ作成 ======
  useEffect(()=>{
    masterRef.current = new Tone.Gain(0.9).toDestination();
    busRef.current = new Tone.Gain(1).connect(masterRef.current);
    setAudioReady(true);

    const raf = requestAnimationFrame(() => {
      onResize();
      requestFrameBoost();
    });
    return ()=>{
      try{ instrumentRef.current?.inst?.dispose?.(); }catch{}
      try{ instrumentRef.current?.chain?.forEach(n=>{n.disconnect?.(); n.dispose?.();}); }catch{}
      try{ busRef.current?.disconnect?.(); busRef.current?.dispose?.(); }catch{}
      try{ masterRef.current?.disconnect?.(); masterRef.current?.dispose?.(); }catch{}
      cancelAnimationFrame(raf);
    };
  },[requestFrameBoost]);

  // ====== 楽器の生成/切替 ======
  useEffect(()=>{
    if(!audioReady || !busRef.current) return;
    if(isOfflineMode && sound !== "synth"){
      setSound("synth");
      return;
    }
    (async()=>{
      setSoundLoading(true);
      setInstReady(false);
      const prev = instrumentRef.current;
      try{
        const next = sound==="synth" ? await createSynthChain()
                   : sound==="piano" ? await createPianoChain(false)
                                     : await createPianoChain(true);
        const last = next.chain[next.chain.length - 1];
        last.connect(busRef.current);
        instrumentRef.current = next;
        setInstReady(true);
      }finally{
        setSoundLoading(false);
        if(prev){
          try{ prev.chain.forEach(n=>n.disconnect?.()); }catch{}
          try{ prev.inst.dispose?.(); }catch{}
          try{ prev.chain.forEach(n=>n.dispose?.()); }catch{}
        }
      }
    })();
  },[sound, audioReady, isOfflineMode]);

  // ショートカット（8は85%）
  useEffect(()=>{
    const onKey=(e)=>{
      const map = {"1":0.2,"2":0.3,"3":0.4,"4":0.5,"5":0.6,"6":0.7,"7":0.8,"8":0.85,"9":0.9,"0":1.0};
      if(map[e.key]!=null) setRate(map[e.key]);
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
  },[]);

  // 速度変更時、位置維持
  useEffect(()=>{
    const now = Tone.now();
    t0Ref.current = now - (playheadRef.current / rate);
    rateRef.current = rate;
    prevTRef.current = playheadRef.current;
  },[rate]);

  // resize - マウント時のみセットアップ、初回リサイズ実行
  useEffect(()=>{
    const handle=()=>onResize();
    window.addEventListener("resize", handle);
    
    // 初回リサイズ（レイアウト確定後）
    const timeout = setTimeout(() => {
      onResize();
    }, 100);
    
    return ()=>{
      window.removeEventListener("resize", handle);
      clearTimeout(timeout);
    };
  },[]); // 空の依存配列 - マウント時のみ
  
  // notes変更時（ファイル読み込み時）にリサイズ
  useEffect(()=>{
    if(notes.length > 0){
      setTimeout(() => onResize(), 50);
    }
  },[notes.length]); // notes.lengthのみ監視

  useEffect(()=>()=>cancelRAF(),[]);

  function onResize(){
    const c = canvasRef.current; if(!c) return;
    const dpr = window.devicePixelRatio||1;
    const rect = c.getBoundingClientRect();
    c.width = Math.floor(rect.width*dpr);
    c.height = Math.floor(rect.height*dpr);
    c.getContext("2d").setTransform(dpr,0,0,dpr,0,0);
    canvasSizeRef.current = { W:rect.width, H:rect.height };
    recomputeVisualEnd(rect.height, notes);
    renderFrame(playheadRef.current);
    requestFrameBoost();
  }

  function cancelRAF(){ rafActiveRef.current=false; if(rafIdRef.current){ cancelAnimationFrame(rafIdRef.current); rafIdRef.current=0; } }
  function startRAF(){
    if(rafActiveRef.current) return;
    rafActiveRef.current=true;
    lastFrameTimeRef.current = 0;
    forceFrameRef.current = true;
    rafIdRef.current=requestAnimationFrame(draw);
  }

  // visualEnd → endTimeRef へ即反映（未確定時はInfinity）
  function recomputeVisualEnd(H, src){
    if(!H || !src.length){
      setVisualEnd(0);
      endTimeRef.current = Infinity; // 未確定なら止めない
      return;
    }
    const visualH = H - KB_HEIGHT;
    let maxT = 0;
    for(const n of src){
      const visDur = Math.max(NOTE_MIN_HEIGHT/SPEED, Math.min(VISUAL_MAX_SEC, n.end-n.start));
      const disappear = n.start + visDur + (visualH/SPEED);
      if(disappear > maxT) maxT = disappear;
    }
    setVisualEnd(maxT);
    endTimeRef.current = maxT; // refに即時反映
  }

  // ====== MIDIロード共通 ======
  async function loadMidiFromBytes(arrayBuffer) {
    try {
      const m = new Midi(arrayBuffer);
      const flat = [];
      m.tracks.forEach(tr=>{
        const ignore = (tr.channel===9) || tr.instrument?.percussion;
        tr.notes.forEach(n=>{
          if(ignore) return;
          if(n.midi<A0_MIDI || n.midi>C8_MIDI) return;
          const dur = n.duration ?? 0;
          flat.push({ i: flat.length, midi:n.midi, start:n.time, end:n.time+dur, vel:n.velocity });
        });
      });
      flat.sort((a,b)=>a.start-b.start);
      const merged = mergeConsecutiveNotes(flat);

      const dur = merged.reduce((mx,n)=>Math.max(mx,n.end),0);
      setNotes(merged);
      setDuration(dur);
      durationRef.current = dur; // refにも保持
      setName("Generated.mid");

      applyRangePreset(rangePreset, merged);

      resetVisualState();

      stop(true);
      const H = canvasSizeRef.current.H || canvasRef.current?.getBoundingClientRect().height || 0;
      recomputeVisualEnd(H, merged);
      renderFrame(0);
    } catch (err) {
      console.error("loadMidiFromBytes failed:", err);
      alert("ライブラリ/MIDIの読み込みに失敗しました。");
    }
  }

  // ====== 生成（MVP：ルールベース） ======
  function toArrayBufferFromU8(u8){
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  const pdPatterns = [
    {
      name: "きらきら星",
      notes: [60, 60, 67, 67, 65, 65, 67, 0, 65, 65, 64, 64, 62, 62, 60, 0],
      durations: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5],
    },
    {
      name: "ちょうちょう",
      notes: [60, 62, 64, 65, 64, 62, 60, 0, 62, 64, 62, 64, 62, 0, 60, 0],
      durations: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 0.5, 1, 0.5],
    },
  ];

  const KEY_TO_SEMITONE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  function buildScaleIntervals(scale){
    return scale==="minor" ? [0,2,3,5,7,8,10,12] : [0,2,4,5,7,9,11,12]; // 自然的短音階/長音階
  }

  function randomChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function clampToRange(m){ return clampMidi(m); }

  async function generateAndLoad() {
    try {
      const tempo = clamp(genTempo, 50, 160);
      const requestedBars = clamp(genBars, 2, 32);
      const difficulty = clamp(genDifficulty, 0, 3);

      const midi = new Midi();
      midi.header.setTempo(tempo);

      if(difficulty === 0){
        const patternSelection =
          genType === "twinkle"
            ? pdPatterns.find(p => p.name === "きらきら星")
            : genType === "butterfly"
            ? pdPatterns.find(p => p.name === "ちょうちょう")
            : randomChoice(pdPatterns);

        const selectedPattern = patternSelection || pdPatterns[0];
        const secondsPerBeat = 60 / tempo;
        const beatsPerBar = 4;
        const targetBeats = beatsPerBar * 4; // 4 bars fixed for beginner mode

        const rightTrack = midi.addTrack();
        rightTrack.name = `${selectedPattern.name} Melody`;

        let beatCursor = 0;
        let idx = 0;
        const notesLength = selectedPattern.notes.length;
        while (beatCursor < targetBeats - 1e-6 && notesLength > 0){
          const patIndex = idx % notesLength;
          const pitch = selectedPattern.notes[patIndex];
          const rawDuration = selectedPattern.durations?.[patIndex] ?? 0.5;
          const safeDuration = Math.max(rawDuration, 0.25);
          const remainingBeats = targetBeats - beatCursor;
          const beatDuration = Math.min(safeDuration, remainingBeats);

          if(pitch !== 0 && beatDuration > 1e-6){
            rightTrack.addNote({
              midi: pitch,
              time: beatCursor * secondsPerBeat,
              duration: beatDuration * secondsPerBeat,
              velocity: 0.8,
            });
          }

          beatCursor += beatDuration;
          idx += 1;
        }

        const leftTrack = midi.addTrack();
        leftTrack.name = `${selectedPattern.name} Bass`;
        const bassNotes = [48, 53, 55, 48]; // C3 - F3 - G3 - C3
        bassNotes.forEach((bassMidi, bar) => {
          leftTrack.addNote({
            midi: bassMidi,
            time: bar * beatsPerBar * secondsPerBeat,
            duration: beatsPerBar * secondsPerBeat,
            velocity: 0.7,
          });
        });

        const bytes = midi.toArray();
        await loadMidiFromBytes(toArrayBufferFromU8(bytes));
        setName(`${selectedPattern.name}_beginner.mid`);
        return;
      }

      const tr = midi.addTrack();
      const bars = requestedBars;
      const effDifficulty = clamp(difficulty, 1, 3);
      const rootSemitone = KEY_TO_SEMITONE[genKey] ?? 0;
      const scale = buildScaleIntervals(genScale);
      const rootOct = 60; // C4を基準、選んだキーにシフト

      // リズム：難易度で密度を切替
      // diff=1: 1/2音符中心, diff=2: 1/4中心, diff=3: 1/8混在
      const rhythmPool =
        effDifficulty===1 ? [1.0, 0.5, 0.5, 1.0] :
        effDifficulty===2 ? [0.5, 0.5, 0.25, 0.25, 1.0] :
                         [0.25, 0.25, 0.5, 0.25, 0.125, 0.375];

      // メロディ方針：スケール内を小さな歩幅でランダムウォーク（跳躍抑制）、小節末は着地
      const totalBeats = bars * 4; // 4/4のみ（MVP）
      let tBeat = 0;
      let degreeIdx = 0; // スケール内の位置
      let currentMidi = clampToRange(rootOct + rootSemitone + scale[degreeIdx]);

      while(tBeat < totalBeats - 1e-6){
        let dur = randomChoice(rhythmPool);
        if(tBeat + dur > totalBeats) dur = totalBeats - tBeat;

        // 小節終端は主音or和声音へ寄せる
        const atBarEnd = Math.abs((tBeat % 4) + dur - 4) < 1e-6;
        const targetDegrees = genScale==="major" ? [0,4,7,12] : [0,3,7,12]; // I和声音
        if(atBarEnd){
          const tg = randomChoice(targetDegrees);
          currentMidi = clampToRange(rootOct + rootSemitone + tg);
        }else{
          // ランダムウォーク：-2..+2度の範囲で移動（跳躍抑制）
          const step = randomChoice([-2,-1,0,1,1,2]); // 上行を少し優先
          degreeIdx = clamp(degreeIdx + step, 0, scale.length-1);
          currentMidi = clampToRange(rootOct + rootSemitone + scale[degreeIdx]);
          // たまにオクターブ上げ下げ（難易度3のみ）
          if(effDifficulty===3 && Math.random()<0.15){
            const up = Math.random()<0.5 ? -12 : 12;
            currentMidi = clampToRange(currentMidi + up);
          }
        }

        // 休符：難易度1で少なめ、3でやや多め
        const restProb = effDifficulty===1 ? 0.05 : effDifficulty===2 ? 0.1 : 0.15;
        const isRest = Math.random() < restProb;

        if(!isRest){
          const timeSec = (tBeat / (tempo/60));
          const durSec  = Math.max(0.12, dur / (tempo/60));
          tr.addNote({
            midi: currentMidi,
            time: timeSec,
            duration: durSec,
            velocity: 0.8 + Math.random()*0.15
          });
        }
        tBeat += dur;
      }

      const bytes = midi.toArray();
      await loadMidiFromBytes(toArrayBufferFromU8(bytes));
      setName(`${genKey}${genScale==="major"?"":"m"}_${tempo}bpm_${bars}bars.mid`);
    } catch (e) {
      console.error(e);
      alert("生成に失敗しました。");
    }
  }

  // ファイル選択
  async function onFile(e){
    const f = e.target.files?.[0]; if(!f) return;
    if(!/\.midi?$/i.test(f.name)){ alert("MIDIファイル（.mid / .midi）を選んでください。"); return; }
    if(f.size > 10 * 1024 * 1024){ alert("ファイルサイズが大きすぎます（10MB以下）"); return; }
    try{
      const buf = await f.arrayBuffer();
      await loadMidiFromBytes(buf);
      setName(f.name);
    }catch(err){
      console.error(err);
      alert("MIDIの読み込みに失敗しました。");
    }
  }

  function applyRangePreset(preset, src){
    let effective = preset;
    if(effective === "24") effective = "48";

    let range;
    if(effective === "auto") range = analyzeNoteRangeAuto(src);
    else if(effective === "48") range = centerPresetRange(MIDDLE_C, 48);
    else if(effective === "61") range = centerPresetRange(MIDDLE_C, 61);
    else if(effective === "76") range = centerPresetRange(MIDDLE_C, 76);
    else if(effective === "88") range = centerPresetRange(MIDDLE_C, 88);
    else range = { minMidi:A0_MIDI, maxMidi:C8_MIDI };

    const normalized = normalizeVisibleRange(range.minMidi, range.maxMidi);
    setViewMinMidi(normalized.minMidi);
    setViewMaxMidi(normalized.maxMidi);

    if(effective !== preset) setRangePreset(effective);
  }
  useEffect(()=>{ applyRangePreset(rangePreset, notes); },[rangePreset]);

  // -------- transport --------
  async function play(){

    await ensureAudioReady();
    if(!masterRef.current) masterRef.current = new Tone.Gain(0.9).toDestination();
    if(!busRef.current)    busRef.current    = new Tone.Gain(1).connect(masterRef.current);
    if(!audioReady) setAudioReady(true);
    if(!notes.length) return;
    const wantsExternal = sound !== "synth";
    const hasExternal = !!instrumentRef.current?.inst && instReady;
    if(wantsExternal && !hasExternal){
      alert("外部音源を読み込み中です。準備できるまで一時的にSynthで再生します。");
      setSound("synth");
      if(!instrumentRef.current?.inst){
        try{
          const fallback = await createSynthChain();
          const last = fallback.chain[fallback.chain.length - 1];
          last.connect(busRef.current);
          instrumentRef.current = fallback;
        }catch(err){
          console.warn("[audio] synth fallback failed:", err);
        }
      }
      if(instrumentRef.current?.inst){
        setInstReady(true);
      }

    }
    cancelRAF();
    requestFrameBoost();
    frameStatsRef.current.lastSample = 0;
    frameStatsRef.current.frames = 0;
    frameStatsRef.current.skipped = 0;
    lastUiUpdateRef.current = 0;

    // 再生開始時に visualEnd を再計算（高さ未確定対策）
    const H = canvasSizeRef.current.H || canvasRef.current?.getBoundingClientRect().height || 0;
    recomputeVisualEnd(H, notes);

    const now = Tone.now();
    t0Ref.current = now - (playheadRef.current / rateRef.current);
    prevTRef.current = playheadRef.current;
    syncUiPlayhead(playheadRef.current, { force: true, timestamp: getNow() });

    masterRef.current?.gain?.rampTo?.(0.9, 0.03);
    isPlayingRef.current = true;
    setIsPlaying(true);
    startRAF();
  }
  function pause(){
    cancelRAF();
    requestFrameBoost();
    const tFreeze = isPlayingRef.current
      ? (Tone.now() - t0Ref.current) * rateRef.current
      : playheadRef.current;

    isPlayingRef.current = false;
    setIsPlaying(false);

    syncUiPlayhead(tFreeze, { force: true, timestamp: getNow() });
    playheadRef.current = tFreeze;
    prevTRef.current = tFreeze;

    masterRef.current?.gain?.rampTo?.(0, 0.03);
    instrumentRef.current?.inst?.releaseAll?.();

    renderFrame(tFreeze);
  }
  function stop(resetToZero=true){
    cancelRAF();
    requestFrameBoost();
    isPlayingRef.current = false;
    setIsPlaying(false);

    const target = resetToZero ? 0 : playheadRef.current;
    syncUiPlayhead(target, { force: true, timestamp: getNow() });
    playheadRef.current = target;
    prevTRef.current = target;
    t0Ref.current = Tone.now() - (target / rateRef.current);

    resetVisualState();

    masterRef.current?.gain?.rampTo?.(0, 0.03);
    instrumentRef.current?.inst?.releaseAll?.();

    renderFrame(target);
  }

  // ====== シーク機能 ======
  function seekTo(targetSec){
    const clamped = clamp(targetSec, 0, Math.max(durationRef.current, isFinite(endTimeRef.current) ? endTimeRef.current : 0));
    const now = Tone.now();
    
    playheadRef.current = clamped;
    prevTRef.current = clamped;
    t0Ref.current = now - (clamped / rateRef.current);
    syncUiPlayhead(clamped, { force: true, timestamp: getNow() });
    
    resetVisualState();
    instrumentRef.current?.inst?.releaseAll?.();
    renderFrame(clamped);
    requestFrameBoost();
  }

  function handleSeekStart(){
    wasPlayingBeforeSeek.current = isPlayingRef.current;
    if(isPlayingRef.current){
      pause();
    }
    isSeekingRef.current = true;
    setIsSeeking(true);
  }

  function handleSeekChange(e){
    const value = parseFloat(e.target.value);
    seekTo(value);
  }

  function handleSeekEnd(){
    isSeekingRef.current = false;
    setIsSeeking(false);
    if(wasPlayingBeforeSeek.current){
      play();
    }
  }

  // A-Bリピート用の関数
  function setPointA(){
    const current = playheadRef.current;
    setAbRepeatA(current);
    if(abRepeatB != null && current >= abRepeatB){
      setAbRepeatB(null);
    }
  }

  function setPointB(){
    const current = playheadRef.current;
    if(abRepeatA != null && current > abRepeatA){
      setAbRepeatB(current);
    } else {
      alert("B点はA点より後に設定してください");
    }
  }

  function clearAbRepeat(){
    setAbRepeatA(null);
    setAbRepeatB(null);
    setAbRepeatEnabled(false);
  }

  // ====== 音を鳴らす（安全化） ======
  function triggerNote(midi, durSec, vel){
    const inst = instrumentRef.current?.inst;
    if(!inst) return;
    try {
      const note = Tone.Frequency(midi, "midi").toNote();
      const velocity = clamp(vel ?? 0.9, 0.1, 1);
      inst.triggerAttackRelease?.(note, durSec, undefined, velocity);
    } catch (error) {
      console.warn("triggerNote failed:", error);
      // 音で失敗してもアプリは止めない
    }
  }

  // ====== 保存/ライブラリ ======
  async function handleSave(){
    if(!notes.length){ alert("保存できる曲がありません。MIDIを読み込むか作曲してください。"); return; }
    const nm = prompt("保存名を入力", name || "Untitled");
    if(nm == null) return;

    const midi = new Midi();
    const tr = midi.addTrack();
    for(const n of notes){
      tr.addNote({ midi:n.midi, time:n.start, duration: Math.max(0.05, n.end-n.start), velocity: n.vel ?? 0.9 });
    }
    const bytes = midi.toArray();
    await saveSong(nm, bytes);
    alert("保存しました。");
  }
  async function openLibrary(){
    const items = await listSongs();
    setLibItems(items);
    setLibOpen(true);
  }
  async function loadFromLibrary(id){
    try{
      const u8 = await loadSongBytes(id);
      if(!u8){ alert("ライブラリからの読み込みに失敗しました。"); return; }
      await loadMidiFromBytes(toArrayBufferFromU8(u8));
      setLibOpen(false);
    }catch(e){
      console.error(e);
      alert("ライブラリからの読み込みに失敗しました。");
    }
  }
  async function removeFromLibrary(id){
    await removeSong(id);
    const items = await listSongs();
    setLibItems(items);
  }

  // -------- drawing --------
  function draw(){
    const perfNow = getNow();
    const boostActive = perfNow < frameBoostUntilRef.current;
    const interval = boostActive ? FAST_FRAME_INTERVAL : frameIntervalRef.current;
    const lastTime = lastFrameTimeRef.current;

    if(!forceFrameRef.current && lastTime && perfNow - lastTime < interval){
      if(isDevEnvironment) recordFrame(perfNow, false);
      if(rafActiveRef.current) rafIdRef.current = requestAnimationFrame(draw);
      return;
    }

    forceFrameRef.current = false;
    lastFrameTimeRef.current = perfNow;
    if(isDevEnvironment) recordFrame(perfNow, true);

    const now = Tone.now();
    let t = isPlayingRef.current ? (now - t0Ref.current)*rateRef.current : playheadRef.current;

    // A-Bリピート判定
    if(isPlayingRef.current && abRepeatEnabledRef.current && abRepeatARef.current != null && abRepeatBRef.current != null){
      if(t >= abRepeatBRef.current){
        resetVisualState();
        instrumentRef.current?.inst?.releaseAll?.();
        t = abRepeatARef.current;
        playheadRef.current = t;
        prevTRef.current = t;
        t0Ref.current = now - (t / rateRef.current);
        syncUiPlayhead(t, { force: true, timestamp: perfNow });
        requestFrameBoost();
      }
    }

    const limitVisual = endTimeRef.current;
    const limit = Math.max(durationRef.current, isFinite(limitVisual) ? limitVisual : 0) + STOP_TAIL;
    const epsilon = 1/60;

    if(isPlayingRef.current && limit>0 && t >= limit - epsilon){
      if(loopEnabledRef.current && notes.length){
        resetVisualState();
        instrumentRef.current?.inst?.releaseAll?.();
        t = 0;
        playheadRef.current = 0;
        prevTRef.current = 0;
        t0Ref.current = now;
        syncUiPlayhead(0, { force: true, timestamp: perfNow });
        requestFrameBoost();
      }else{
        t = limit;
        isPlayingRef.current = false;
        setIsPlaying(false);
        syncUiPlayhead(limit, { force: true, timestamp: perfNow });
        playheadRef.current = limit;
        masterRef.current?.gain?.rampTo?.(0, 0.03);
        instrumentRef.current?.inst?.releaseAll?.();
        renderFrame(limit);
        cancelRAF();
        return;
      }
    }

    if(isPlayingRef.current){
      playheadRef.current = t;
      syncUiPlayhead(t, { timestamp: perfNow });
    }

    const metrics = renderFrame(t);
    if(!boostActive){
      frameIntervalRef.current = determineFrameInterval(metrics);
    }

    if(rafActiveRef.current) rafIdRef.current = requestAnimationFrame(draw);
  }

  // 半音等間隔のX計算
  function keyCountVisible(){ return Math.max(1, (viewMaxMidi - viewMinMidi + 1)); }
  function xForMidi(midi, W){ return ((midi - viewMinMidi) / keyCountVisible()) * W; }
  function keyWidth(W){ return W / keyCountVisible(); }

  function computeKeyboardGeom(W, minMidi, maxMidi) {

    // count visible white keys
    let totalWhiteKeys = 0;
    for (let m = minMidi; m <= maxMidi; m++) if (isWhite(m)) totalWhiteKeys++;


    const whiteW = W / Math.max(1, totalWhiteKeys);
    const blackW = whiteW * BLACK_W_RATIO;


    const countWhitesBefore = (pitch) => {
      let c = 0;
      for (let m = minMidi; m < pitch; m++) if (isWhite(m)) c++;
      return c;
    };

    function centerFor(midi) {
      if (isWhite(midi)) {
        return countWhitesBefore(midi) * whiteW + whiteW / 2;
      } else {
        // Anchor to whichever boundary white key is visible
        let L = midi - 1; while (L >= minMidi && !isWhite(L)) L--;
        let R = midi + 1; while (R <= maxMidi && !isWhite(R)) R++;

        if (L >= minMidi) {
          // right edge of left white key
          return (countWhitesBefore(L) + 1) * whiteW;
        } else if (R <= maxMidi) {
          // left edge of right white key
          return countWhitesBefore(R) * whiteW;
        } else {
          // fallback (shouldn't happen)
          return whiteW / 2;
        }
      }
    }

    const widthFor = (midi) => (isWhite(midi) ? whiteW : blackW);

    return { centerFor, widthFor };
  }

  function renderFrame(t){
    const c = canvasRef.current; if(!c) return;
    const ctx = c.getContext("2d");
    const { W, H } = canvasSizeRef.current;
    if(!W || !H) return;

    const geom = computeKeyboardGeom(W, viewMinMidi, viewMaxMidi);

    // bg
    const base = {r:9,g:17,b:25};
    const k = (effectLevel!=="focus") ? bgIntensityRef.current : 0;
    const r = Math.min(255, base.r + k*20);
    const g = Math.min(255, base.g + k*15);
    const b = Math.min(255, base.b + k*10);
    ctx.fillStyle = `rgb(${r|0},${g|0},${b|0})`;
    ctx.fillRect(0,0,W,H);

    // グリッド
    ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
    const totalVisual = H - KB_HEIGHT;
    const secTop = Math.floor(t - 2);
    const secBottom = Math.ceil(t + totalVisual / SPEED + 2);
    for(let s=secTop; s<=secBottom; s++){
      const y = timeToY(t, s);
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
    }

    const keylineY = H - KB_HEIGHT;
    const tPrev = prevTRef.current;
    const dt = Math.max(0, t - tPrev);
    bgIntensityRef.current = Math.max(0, bgIntensityRef.current - dt*2);

    // 古いトレイル間引き
    if(effectLevel!=="focus"){
      for(const [id, trail] of trailsRef.current){
        const filtered = trail.filter(p => t - p.time < 0.8);
        if(filtered.length) trailsRef.current.set(id, filtered);
        else trailsRef.current.delete(id);
      }
    }

    // ----- NOTES（鍵盤の上に出ないようクリップ） -----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, keylineY);
    ctx.clip();

    const noteBatches = new Map();
    const overlayShapes = [];
    const metrics = { drawnNotes: 0, nearKeyline: 0 };
    const drawRectOnly = effectLevel === "focus" || noteStyle === "rect";
    const shouldDrawOverlay = !drawRectOnly;

    // 可視範囲のノートだけを走査
    const lookBack = (totalVisual / SPEED) + VISUAL_MAX_SEC + 1.0;
    const lookAhead = (totalVisual / SPEED) + 1.0;
    const winStart = t - lookBack;
    const winEnd   = t + lookAhead;

    const starts = noteStartsRef.current;
    for (let idx = lowerBound(starts, winStart);
         idx < notes.length && notes[idx].start <= winEnd;
         idx++) {

      const n = notes[idx];
      const durSec = n.end - n.start;
      const visSec = Math.max(NOTE_MIN_HEIGHT / SPEED, Math.min(VISUAL_MAX_SEC, durSec));
      const h = visSec * SPEED;

      const yTop = timeToYTop(t, n.start, totalVisual, h);
      const yBottom = yTop + h;
      const yTopPrev = timeToYTop(tPrev, n.start, totalVisual, h);
      const yBottomPrev = yTopPrev + h;

      const cx = geom.centerFor(n.midi);
      const keyW = geom.widthFor(n.midi);
      const baseX = cx - keyW / 2;
      const width = Math.max(1, keyW - 2);

      // 発音判定（try/catchで保護）
      const crossed = (yBottomPrev < keylineY) && (yBottom >= keylineY);
      const justLanded = isPlayingRef.current && crossed && !landedAtRef.current.has(n.i);
      if(justLanded){
        try{
          const durPlay = Math.max(0.05, durSec / rateRef.current);
          triggerNote(n.midi, durPlay, n.vel);
          landedAtRef.current.set(n.i, t);
          keyFlashRef.current.set(n.midi, t + (FLASH_MS/1000)/rateRef.current);
        }catch(err){
          console.warn("Note trigger failed:", err);
        }

        // ビジュアル（音が失敗しても実行）
        if(effectLevel!=="focus"){
          const xCenter = cx;
          const pc = isWhite(n.midi) ? COLORS.particleWhite : COLORS.particleBlack;
          if(effectLevel==="standard"){
            spawnRipple(ripplesRef.current, {x:xCenter, y:keylineY}, "standard");
          }else{
            // effectLevel = fun-refined / fun-elegant / fun-colorful / fun-original
            
            // 背景光の設定
            if(effectLevel === "fun-original"){
              bgIntensityRef.current = Math.min(1, bgIntensityRef.current + (n.vel||0.9)*0.3);
            }
            
            // 色相範囲の設定
            let hue;
            if(effectLevel === "fun-refined"){
              // 洗練版：青～緑（180-120）
              hue = 180 - (clamp(n.midi, A0_MIDI, C8_MIDI)-A0_MIDI) * ((180-120)/KEY_COUNT);
            }else if(effectLevel === "fun-elegant"){
              // エレガント：白基調（色相は控えめ）
              hue = 200; // 固定で青系
            }else if(effectLevel === "fun-colorful"){
              // カラフル：ランダムな色（赤・オレンジ・黄・緑・青・紫など）
              const colorPalette = [0, 30, 60, 120, 180, 240, 280, 320]; // 赤・オレンジ・黄・緑・青・青紫・紫・ピンク
              hue = colorPalette[Math.floor(Math.random() * colorPalette.length)];
            }else{
              // オリジナル：青～オレンジ（210-55）
              hue = 210 - (clamp(n.midi, A0_MIDI, C8_MIDI)-A0_MIDI) * ((210-55)/KEY_COUNT);
            }
            
            const width = 6 + (n.vel||0.9)*12;
            const life  = 1.4 + (n.vel||0.9)*0.4;
            
            // エレガント版は光柱なし、他は光柱あり
            if(effectLevel !== "fun-elegant"){
              aurasRef.current.push({ x:xCenter, y:keylineY, hue, width, life, age:0, preset: effectLevel });
            }
            
            spawnRipple(ripplesRef.current, {x:xCenter, y:keylineY}, effectLevel);
            spawnParticles(particlesRef.current, {x:xCenter, y:keylineY, color:pc}, effectLevel);
          }
        }
      }

      // 可視レンジ外
      const inView = (n.midi >= viewMinMidi-1 && n.midi <= viewMaxMidi+1);
      if(!inView) { trailsRef.current.delete(n.i); continue; }
      if(yTop>H || yBottom<0){ trailsRef.current.delete(n.i); continue; }

      metrics.drawnNotes += 1;
      if(yBottom >= keylineY - 40 && yBottom <= keylineY + 160) metrics.nearKeyline += 1;

      const x = baseX + 1;

      // トレイル
      if(effectLevel!=="focus" && isPlayingRef.current && yTop>=0 && yTop<=keylineY){
        if(!trailsRef.current.has(n.i)) trailsRef.current.set(n.i, []);
        const trail = trailsRef.current.get(n.i);
        trail.push({ x: cx, y: yTop + h/2, time: t, color: isWhite(n.midi) ? COLORS.trailWhite : COLORS.trailBlack });
        if(trail.length>8) trail.shift();
      }

      const landedAt = landedAtRef.current.get(n.i);
      const litUntil = landedAt!=null ? (landedAt + Math.max(MIN_LIT_SEC, durSec/rateRef.current)) : 0;
      const isLit = landedAt!=null && t <= litUntil + 0.02;

      const isW = isWhite(n.midi);
      const fill = isW ? (isLit?COLORS.noteWhiteActive:COLORS.noteWhite) : (isLit?COLORS.noteBlackActive:COLORS.noteBlack);
      const batchKey = fill;
      if(!noteBatches.has(batchKey)) noteBatches.set(batchKey, []);
      noteBatches.get(batchKey).push({ x, y: yTop, w: width, h });

      if(shouldDrawOverlay){
        const cy = yTop + h / 2;
        overlayShapes.push({ cx, cy, size: Math.min(width, h*0.4)/2, midi: n.midi, width, height: h });
      }
    }

    for(const [fill, boxes] of noteBatches.entries()){
      ctx.fillStyle = fill;
      ctx.beginPath();
      for(const box of boxes){
        addRoundedRectPath(ctx, box.x, box.y, box.w, box.h);
      }
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if(shouldDrawOverlay && overlayShapes.length){
      ctx.save();
      
      if(noteStyle === "note-jp" || noteStyle === "note-en"){
        // 音名表示
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 13px ui-sans-serif, system-ui, sans-serif";
        
        for(const shape of overlayShapes){
          const noteName = noteStyle === "note-jp" 
            ? nameDoReMi(shape.midi).name 
            : nameAG(shape.midi).name;
          
          // 影（読みやすさ向上）
          ctx.fillStyle = "rgba(0,0,0,0.4)";
          ctx.fillText(noteName, shape.cx + 1, shape.cy + 1);
          
          // 本体
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.fillText(noteName, shape.cx, shape.cy);
        }
      } else {
        // 星・ハート表示（サイズ固定）
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.strokeStyle = "rgba(0,0,0,0.15)";
        ctx.lineWidth = 1;
        const fixedSize = 8; // 固定サイズ
        
        for(const shape of overlayShapes){
          if(noteStyle === "star") drawStar(ctx, shape.cx, shape.cy, fixedSize, 5);
          else drawHeart(ctx, shape.cx, shape.cy, fixedSize);
          ctx.fill();
          ctx.stroke();
        }
      }
      
      ctx.restore();
    }

    if(effectLevel!=="focus") drawTrails(ctx, trailsRef.current, t);
    if(effectLevel!=="focus") drawAuras(ctx, aurasRef.current, dt, keylineY);
    drawRipples(ctx, ripplesRef.current, dt);
    drawParticles(ctx, particlesRef.current, dt);

    ctx.restore();

    // keyboard
    drawKeyboardUniform(ctx, 0, H-KB_HEIGHT, W, KB_HEIGHT, t, notes, viewMinMidi, viewMaxMidi, labelMode);

    // edge fade
    drawEdgeFade(ctx, W, H);

    // HUD
    ctx.fillStyle = COLORS.text; ctx.font = "12px ui-sans-serif, system-ui";
    ctx.fillText(`${fmt(t)} / ${fmt(Math.max(durationRef.current, isFinite(endTimeRef.current)?endTimeRef.current:0))}  (${Math.round(rateRef.current*100)}%)`, 10, 16);

    prevTRef.current = t;
    return metrics;
  }
  function drawStar(ctx, cx, cy, r, spikes=5){
    const step = Math.PI / spikes;
    ctx.beginPath();
    for(let i=0;i<2*spikes;i++){
      const rad = i*step;
      const rr = (i%2===0) ? r : r*0.5;
      const x = cx + Math.cos(rad - Math.PI/2)*rr;
      const y = cy + Math.sin(rad - Math.PI/2)*rr;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.closePath();
  }
  function drawHeart(ctx, cx, cy, r){
    const s = r/1.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy + s*0.6);
    ctx.bezierCurveTo(cx + s, cy - s*0.4, cx + s*0.6, cy - s*1.2, cx, cy - s*0.4);
    ctx.bezierCurveTo(cx - s*0.6, cy - s*1.2, cx - s, cy - s*0.4, cx, cy + s*0.6);
    ctx.closePath();
  }

  function drawTrails(ctx, trails, now){
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    for(const trail of trails.values()){
      if(trail.length<2) continue;
      for(let i=1;i<trail.length;i++){
        const p1 = trail[i-1], p2 = trail[i];
        const age = now - p2.time;
        const alpha = Math.max(0, 1 - age/0.8) * 0.6;
        const rgba = (p2.color.startsWith("rgb("))
          ? p2.color.replace("rgb(", "rgba(").replace(")", `,${alpha})`)
          : p2.color;
        ctx.strokeStyle = rgba;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawRipples(ctx, ripples, dt){
    const next = [];
    for(const r of ripples){
      r.age += dt;
      if(r.age < r.life + r.delay){ next.push(r); }
    }
    ripples.length = 0; ripples.push(...next);

    ctx.save();
    for(const r of ripples){
      if(r.age < r.delay) continue;
      const progress = (r.age - r.delay) / r.life;
      const radius = progress * r.maxRadius;
      const alpha = (1 - progress) * 0.7;
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, Math.PI*2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles(ctx, arr, dt){
    if(arr.length > 800) arr.splice(0, arr.length - 800);
    const g = 980;
    const next = [];
    for(const p of arr){
      const age = p.age + dt;
      if(age < p.life){
        const newX = p.x + p.vx*dt;
        const newY = p.y + p.vy*dt + 0.5*g*dt*dt;
        const newVy = p.vy + g*dt;
        next.push({...p, x:newX, y:newY, vy:newVy, age});
      }
    }
    arr.length = 0; arr.push(...next);

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for(const p of arr){
      const alpha = 1 - (p.age/p.life);
      ctx.save();
      ctx.globalAlpha = alpha*0.9;
      if(p.sparkle && Math.sin(p.age*15)>0.3){
        ctx.shadowBlur = 8;
        ctx.shadowColor = p.color;
      }
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function drawAuras(ctx, auras, dt, keylineY){
    const next = [];
    for(const a of auras){
      a.age += dt;
      if(a.age < a.life) next.push(a);
    }
    auras.length = 0; auras.push(...next);

    for(const a of auras){
      const progress = a.age / a.life;
      const preset = a.preset || 'fun-refined';
      
      // プリセットごとの設定
      let alphaMultiplier, height, saturation;
      if(preset === 'fun-refined'){
        alphaMultiplier = 0.5; height = 154; saturation = 90;
      }else if(preset === 'fun-elegant'){
        alphaMultiplier = 0.3; height = 100; saturation = 50;
      }else if(preset === 'fun-colorful'){
        alphaMultiplier = 0.8; height = 200; saturation = 100;
      }else{ // fun-original
        alphaMultiplier = 0.9; height = 220; saturation = 90;
      }
      
      const alpha = (1 - progress) * alphaMultiplier;
      const topY = keylineY - height;
      const grd = ctx.createLinearGradient(a.x, keylineY, a.x, topY);
      grd.addColorStop(0, `hsla(${a.hue},${saturation}%,65%,${alpha})`);
      grd.addColorStop(1, `hsla(${a.hue},${saturation}%,65%,0)`);
      ctx.fillStyle = grd;
      const w = a.width * (1 + 0.2*Math.sin(a.age*6));
      ctx.fillRect(a.x - w/2, topY, w, keylineY-topY);

      const rg = ctx.createRadialGradient(a.x, keylineY, 0, a.x, keylineY, 28);
      rg.addColorStop(0, `hsla(${a.hue},${saturation}%,75%,${alpha*0.5})`);
      rg.addColorStop(1, `hsla(${a.hue},${saturation}%,75%,0)`);
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(a.x, keylineY, 28, 0, Math.PI*2); ctx.fill();
    }
  }

  // 半音等間隔の鍵盤
  function drawKeyboardUniform(ctx, x, y, w, h, t, allNotes, minMidi, maxMidi, labelMode){
    // 1. 表示範囲内の白鍵総数を計算
    let totalWhiteKeys = 0;
    for (let m = minMidi; m <= maxMidi; m++) {
      if (isWhite(m)) {
        totalWhiteKeys++;
      }
    }

    // 2. 白鍵の基本幅を決定
    const whiteKeyWidth = w / Math.max(1, totalWhiteKeys);

    // 3. 各MIDIノートのレイアウト情報を計算
    const keyLayout = new Map();

    // 白鍵の位置を先に計算
    let currentWhiteX = x;
    const whiteKeyPositions = new Map();

    for (let m = minMidi; m <= maxMidi; m++) {
      if (isWhite(m)) {
        const layout = {
          x: currentWhiteX,
          y: y,
          w: whiteKeyWidth,
          h: h,
          isWhite: true
        };
        keyLayout.set(m, layout);
        whiteKeyPositions.set(m, currentWhiteX);
        currentWhiteX += whiteKeyWidth;
      }
    }

    // 4. 黒鍵の位置を計算
    for (let m = minMidi; m <= maxMidi; m++) {
      if (!isWhite(m)) {
        const blackKeyWidth = whiteKeyWidth * BLACK_W_RATIO;
        const blackKeyHeight = h * BLACK_H_RATIO;

        let leftWhite = m - 1;
        while (leftWhite >= minMidi && !isWhite(leftWhite)) {
          leftWhite--;
        }

        if (leftWhite >= minMidi && whiteKeyPositions.has(leftWhite)) {
          const leftWhiteX = whiteKeyPositions.get(leftWhite);
          const blackKeyX = leftWhiteX + whiteKeyWidth - (blackKeyWidth / 2);

          keyLayout.set(m, {
            x: blackKeyX,
            y: y,
            w: blackKeyWidth,
            h: blackKeyHeight,
            isWhite: false
          });
        }
      }
    }

    // 5. 鍵盤の上縁の影
    ctx.fillStyle = COLORS.keyShadow;
    ctx.fillRect(x, y - 6, w, 6);

    // 6. 【下レイヤー】白鍵を境界線付きで完全な長方形として描画
    ctx.save();

    for (let m = minMidi; m <= maxMidi; m++) {
      const layout = keyLayout.get(m);
      if (!layout || !layout.isWhite) continue;

      if (effectLevel === "focus") {
        // シンプルモード：白鍵本体 + 境界線
        ctx.fillStyle = COLORS.whiteKey;
        ctx.fillRect(layout.x, layout.y, layout.w, layout.h);

        // 各白鍵を細い線で完全に囲む
        ctx.strokeStyle = COLORS.keyBorder;
        ctx.lineWidth = 1;
        ctx.lineJoin = "miter";
        ctx.lineCap = "butt";
        ctx.strokeRect(layout.x + 0.5, layout.y + 0.5, layout.w - 1, layout.h - 1);
      } else {
        // 高品質モード：質感 + 境界線

        // ベースグラデーション
        const g = ctx.createLinearGradient(layout.x, layout.y, layout.x, layout.y + layout.h);
        g.addColorStop(0, "#f7f9fb");
        g.addColorStop(0.5, "#eef2f7");
        g.addColorStop(1, "#e3e8ef");
        ctx.fillStyle = g;
        ctx.beginPath();
        drawRoundedRect(ctx, layout.x, layout.y, layout.w - 1, layout.h, 5);
        ctx.fill();

        // サイドシャドウ
        const side = ctx.createLinearGradient(layout.x, layout.y, layout.x + layout.w, layout.y);
        side.addColorStop(0.0, "rgba(0,0,0,0.10)");
        side.addColorStop(0.08, "rgba(0,0,0,0.00)");
        side.addColorStop(0.92, "rgba(0,0,0,0.00)");
        side.addColorStop(1.0, "rgba(0,0,0,0.10)");
        ctx.fillStyle = side;
        ctx.fillRect(layout.x, layout.y, layout.w - 1, layout.h);

        // トップグロス
        const gloss = ctx.createLinearGradient(layout.x, layout.y, layout.x, layout.y + layout.h * 0.28);
        gloss.addColorStop(0, "rgba(255,255,255,0.65)");
        gloss.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = gloss;
        ctx.fillRect(layout.x + 1, layout.y + 1, layout.w - 3, layout.h * 0.28);

        // ★重要：外側境界線（各白鍵を完全に囲む）
        ctx.strokeStyle = COLORS.keyBorder;
        ctx.lineWidth = 1;
        ctx.lineJoin = "miter";
        ctx.lineCap = "butt";
        ctx.strokeRect(layout.x + 0.5, layout.y + 0.5, layout.w - 1, layout.h - 1);
      }
    }

    ctx.restore();

    // 7. 【上レイヤー】黒鍵を描画（白鍵の境界線を自然に隠す）
    for (let m = minMidi; m <= maxMidi; m++) {
      const layout = keyLayout.get(m);
      if (!layout || layout.isWhite) continue;

      if (effectLevel === "focus") {
        ctx.fillStyle = COLORS.blackKey;
        ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
      } else {
        drawBlackKey(ctx, layout.x, layout.y, layout.w, layout.h, false);
      }
    }

    // 8. アクティブ表示
    const active = new Set();
    for(const [id, landedAt] of landedAtRef.current){
      const n = allNotes[id];
      if(!n) continue;
      if(n.midi < minMidi || n.midi > maxMidi) continue;
      const litUntil = landedAt + Math.max(MIN_LIT_SEC, (n.end-n.start)/rateRef.current);
      if(t <= litUntil + 0.02) active.add(n.midi);
    }

    for(const midi of active){
      const layout = keyLayout.get(midi);
      if(!layout) continue;

      const flashEnd = keyFlashRef.current.get(midi) ?? 0;
      const flashDur = (FLASH_MS/1000)/rateRef.current;
      const flashAlpha = Math.max(0, Math.min(1, (flashEnd - t)/flashDur));
      const base = layout.isWhite ? COLORS.keyActiveWhite : COLORS.keyActiveBlack;
      ctx.fillStyle = base;

      if(layout.isWhite){
        ctx.globalAlpha = 0.35;
        ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
        if(flashAlpha > 0){
          ctx.globalAlpha = 0.35 + 0.35 * flashAlpha;
          ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
        }
      } else {
        ctx.globalAlpha = 0.4;
        ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
        if(flashAlpha > 0){
          ctx.globalAlpha = 0.4 + 0.35 * flashAlpha;
          ctx.fillRect(layout.x, layout.y, layout.w, layout.h);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 9. Cマーカー
    ctx.save();
    for(let m = minMidi; m <= maxMidi; m++){
      if(m % 12 !== 0) continue;
      const layout = keyLayout.get(m);
      if(!layout || !layout.isWhite) continue;

      const cx = layout.x + layout.w / 2;
      const isC4 = (m === MIDDLE_C);
      ctx.strokeStyle = isC4 ? COLORS.markerC4 : COLORS.markerC;
      ctx.lineWidth = isC4 ? 3 : 2;
      ctx.beginPath(); 
      ctx.moveTo(cx, y - 6); 
      ctx.lineTo(cx, y - 1); 
      ctx.stroke();
      
      if(isC4){
        ctx.fillStyle = "rgba(251,191,36,0.2)";
        ctx.beginPath(); 
        ctx.arc(cx, y - 10, 10, 0, Math.PI * 2); 
        ctx.fill();
        ctx.fillStyle = COLORS.markerC4; 
        ctx.font = "bold 10px ui-sans-serif, system-ui"; 
        ctx.textAlign = "center";
        ctx.fillText("C4", cx, y - 10);
      }
    }
    ctx.restore();

    // 10. ラベル
    if(labelMode !== "none"){
      ctx.save();
      ctx.fillStyle = COLORS.label;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "11px ui-sans-serif, system-ui";

      for(let m = minMidi; m <= maxMidi; m++){
        const layout = keyLayout.get(m);
        if(!layout || !layout.isWhite) continue;

        const cx = layout.x + layout.w / 2;
        const { name, octave } = (labelMode === "AG") ? nameAG(m) : nameDoReMi(m);
        const text = (labelMode === "AG") ? `${name}${octave}` : name;
        ctx.fillText(text, cx, layout.y + layout.h - 12);
      }
      ctx.restore();
    }
  }

  function drawEdgeFade(ctx, W, H){
    const fadeW = Math.max(24, W*0.09);
    const lgL = ctx.createLinearGradient(0,0,fadeW,0);
    lgL.addColorStop(0, COLORS.fadeEdge); lgL.addColorStop(1,"rgba(0,0,0,0)");
    ctx.fillStyle = lgL; ctx.fillRect(0,0,fadeW,H);
    const lgR = ctx.createLinearGradient(W-fadeW,0,W,0);
    lgR.addColorStop(0,"rgba(0,0,0,0)"); lgR.addColorStop(1, COLORS.fadeEdge);
    ctx.fillStyle = lgR; ctx.fillRect(W-fadeW,0,fadeW,H);
  }

  const fmt = (sec)=>{ const s=Math.max(0, sec|0); const m=(s/60)|0; const r=(s%60).toString().padStart(2,"0"); return `${m}:${r}`; };
  const speedOptions = [0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.85,0.9,1.0];
  const fmtDate = (ts)=>new Date(ts).toLocaleString();
  const { totalDuration, progressPercent } = useMemo(() => {
    const visual = Number.isFinite(visualEnd) ? visualEnd : 0;
    const total = Math.max(duration, visual);
    if (total <= 0) {
      return { totalDuration: 0, progressPercent: 0 };
    }
    const ratio = Math.min(1, playhead / total);
    return { totalDuration: total, progressPercent: Math.round(ratio * 100) };
  }, [duration, visualEnd, playhead]);

  const offlineDisabledTooltip = isOfflineMode ? "オフラインでは生成と外部音源が利用できません" : undefined;
  const onlineStatusLabel = isOfflineMode ? "🔴オフライン" : "🟢オンライン";
  const onlineStatusClass = isOfflineMode
    ? "bg-rose-600/20 text-rose-200 border border-rose-500/40"
    : "bg-emerald-600/20 text-emerald-200 border border-emerald-500/40";


  return (
    <div className="h-screen bg-slate-900 text-slate-100 flex flex-col overflow-hidden">
      {/* フォーカスモード: キャンバスのみ表示 */}
      {focusMode ? (
        <div className="relative flex-1">
          <canvas ref={canvasRef} className="w-full h-full block" />
          {/* フォーカスモード解除ボタン */}
          <button
            className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center bg-slate-800/80 hover:bg-slate-700/80 rounded-full backdrop-blur transition"
            onClick={() => setFocusMode(false)}
            title="フォーカスモード解除"
          >
            ✕
          </button>
        </div>
      ) : (
        <>
          {/* コンパクトヘッダー（50px） */}
          <header className="h-[50px] bg-slate-900/95 backdrop-blur border-b border-slate-800 flex items-center px-3 gap-2 shrink-0">
            {/* メニューボタン */}
            <button
              className="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-lg transition"
              onClick={() => setMenuOpen(true)}
              title="メニュー"
            >
              <span className="text-xl">≡</span>
            </button>

            {/* 曲名表示 */}
            <div className="flex-1 min-w-0 text-sm font-medium truncate px-2">
              {name || "No file loaded"}
            </div>

            {/* 再生コントロール */}
            <button
              className="w-9 h-9 flex items-center justify-center bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
              disabled={!notes.length || isPlaying}
              onClick={play}
              title="再生"
            >
              ▶
            </button>
            <button
              className="w-9 h-9 flex items-center justify-center bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
              disabled={!isPlaying}
              onClick={pause}
              title="一時停止"
            >
              ⏸
            </button>
            <button
              className="w-9 h-9 flex items-center justify-center bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
              disabled={!notes.length}
              onClick={() => stop(true)}
              title="停止"
            >
              ⏹
            </button>

            {/* 速度セレクター */}
            <select
              className="h-9 px-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition"
              value={rate}
              onChange={e => setRate(parseFloat(e.target.value))}
              title="再生速度"
            >
              {speedOptions.map(v => (
                <option key={v} value={v}>
                  {Math.round(v * 100)}%
                </option>
              ))}
            </select>

            {/* クイック設定: エフェクト */}
            <select
              className="h-9 px-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition"
              value={effectLevel}
              onChange={e => setEffectLevel(e.target.value)}
              title="エフェクト"
            >
              <option value="focus">🎯 集中</option>
              <option value="standard">✨ 標準</option>
              <option value="fun-refined">🎉 洗練</option>
              <option value="fun-elegant">🌟 エレガント</option>
              <option value="fun-colorful">🎪 カラフル</option>
              <option value="fun-original">💫 オリジナル</option>
            </select>

            {/* クイック設定: ノート装飾 */}
            <select
              className="h-9 px-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition"
              value={noteStyle}
              onChange={e => setNoteStyle(e.target.value)}
              title="ノート装飾"
            >
              <option value="rect">シンプル</option>
              <option value="note-jp">🎵 ドレミ</option>
              <option value="note-en">🎵 CDE</option>
              <option value="star">⭐ 星</option>
              <option value="heart">❤️ ハート</option>
            </select>

            {/* クイック設定: 鍵盤範囲 */}
            <select
              className="h-9 px-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs transition"
              value={rangePreset}
              onChange={e => setRangePreset(e.target.value)}
              title="鍵盤範囲"
            >
              <option value="auto">Auto</option>
              <option value="48">48鍵</option>
              <option value="61">61鍵</option>
              <option value="76">76鍵</option>
              <option value="88">88鍵</option>
            </select>

            {/* フォーカスモード切替 */}
            <button
              className="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-lg transition"
              onClick={() => setFocusMode(true)}
              title="フォーカスモード"
            >
              🎯
            </button>

            {/* 設定ボタン */}
            <button
              className="w-9 h-9 flex items-center justify-center hover:bg-slate-800 rounded-lg transition"
              onClick={() => setSettingsOpen(true)}
              title="設定"
            >
              ⚙
            </button>
          </header>

          {/* メインコンテンツエリア */}
          <main className="flex-1 flex flex-col min-h-0">
            {/* キャンバスエリア */}
            <div className="flex-1 relative">
              <canvas ref={canvasRef} className="w-full h-full block" />
            </div>

            {/* シークバー & A-Bコントロールエリア */}
            <div className="bg-slate-900/95 backdrop-blur border-t border-slate-800 px-3 py-2 space-y-2 shrink-0">
              {/* 進捗表示 */}
              <div className="flex items-center justify-between text-xs text-slate-300">
                <span className="font-mono">{fmt(playhead)} / {fmt(totalDuration)}</span>
                <span className="text-slate-400">{progressPercent}%</span>
              </div>

              {/* シークバー */}
              <div className="relative">
                <input
                  type="range"
                  min={0}
                  max={totalDuration || 1}
                  step={0.01}
                  value={playhead}
                  onChange={handleSeekChange}
                  onMouseDown={handleSeekStart}
                  onMouseUp={handleSeekEnd}
                  onTouchStart={handleSeekStart}
                  onTouchEnd={handleSeekEnd}
                  disabled={!notes.length}
                  className="w-full h-3 bg-slate-700 rounded-lg appearance-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    background: notes.length ? `linear-gradient(to right, #10b981 0%, #10b981 ${progressPercent}%, #334155 ${progressPercent}%, #334155 100%)` : '#334155'
                  }}
                />
                {/* A-Bリピートマーカー */}
                {abRepeatA != null && totalDuration > 0 && (
                  <div
                    className="absolute top-0 h-3 w-1 bg-blue-400 pointer-events-none"
                    style={{ left: `${(abRepeatA / totalDuration) * 100}%` }}
                  />
                )}
                {abRepeatB != null && totalDuration > 0 && (
                  <div
                    className="absolute top-0 h-3 w-1 bg-red-400 pointer-events-none"
                    style={{ left: `${(abRepeatB / totalDuration) * 100}%` }}
                  />
                )}
              </div>

              {/* A-Bリピートコントロール */}
              <div className="flex items-center gap-2 text-xs">
                <button
                  className="px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={setPointA}
                  disabled={!notes.length}
                  title="A点設定"
                >
                  A
                </button>
                <button
                  className="px-2 py-1 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={setPointB}
                  disabled={!notes.length || abRepeatA == null}
                  title="B点設定"
                >
                  B
                </button>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={abRepeatEnabled}
                    onChange={e => setAbRepeatEnabled(e.target.checked)}
                    disabled={abRepeatA == null || abRepeatB == null}
                  />
                  <span className={abRepeatA == null || abRepeatB == null ? "opacity-50" : ""}>A-Bリピート</span>
                </label>
                <button
                  className="px-2 py-1 rounded bg-slate-600 hover:bg-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={clearAbRepeat}
                  disabled={abRepeatA == null && abRepeatB == null}
                  title="A-B点クリア"
                >
                  クリア
                </button>
                {abRepeatA != null && (
                  <span className="text-blue-300">A: {fmt(abRepeatA)}</span>
                )}
                {abRepeatB != null && (
                  <span className="text-red-300 ml-2">B: {fmt(abRepeatB)}</span>
                )}
              </div>
            </div>
          </main>

          {/* 左サイドメニューパネル */}
          {menuOpen && (
            <>
              <div
                className="fixed inset-0 bg-black/60 z-40"
                onClick={() => setMenuOpen(false)}
              />
              <aside className="fixed top-0 left-0 bottom-0 w-80 max-w-[85vw] bg-slate-800 shadow-2xl z-50 overflow-y-auto">
                <div className="p-4 space-y-4">
                  {/* ヘッダー */}
                  <div className="flex items-center justify-between border-b border-slate-700 pb-3">
                    <h2 className="text-lg font-semibold">メニュー</h2>
                    <button
                      className="w-8 h-8 flex items-center justify-center hover:bg-slate-700 rounded transition"
                      onClick={() => setMenuOpen(false)}
                    >
                      ✕
                    </button>
                  </div>

                  {/* オンライン/オフライン状態 */}
                  <div className={`px-3 py-2 rounded-lg text-xs ${onlineStatusClass}`}>
                    {onlineStatusLabel}
                  </div>
                  {isOfflineMode && (
                    <div className="text-xs text-amber-200 bg-amber-900/20 border border-amber-400/40 rounded-lg px-3 py-2">
                      オフライン中は生成・外部音源が無効です
                    </div>
                  )}

                  {/* ファイル操作 */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-300">ファイル</h3>
                    <label className="block w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg cursor-pointer text-center transition">
                      MIDI読み込み
                      <input
                        type="file"
                        accept=".mid,.midi"
                        className="hidden"
                        onChange={onFile}
                      />
                    </label>
                    <button
                      className="w-full px-4 py-3 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
                      onClick={handleSave}
                      disabled={!notes.length}
                    >
                      保存
                    </button>
                    <button
                      className="w-full px-4 py-3 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
                      onClick={openLibrary}
                    >
                      ライブラリ
                    </button>
                  </div>

                  {/* 楽曲生成 */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-300">楽曲生成</h3>
                    
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-16 text-slate-400">Key</span>
                      <select className="flex-1 bg-slate-700 rounded-lg px-3 py-2" value={genKey} onChange={e => setGenKey(e.target.value)}>
                        {["C", "D", "E", "F", "G", "A", "B"].map(k => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                      <select className="flex-1 bg-slate-700 rounded-lg px-3 py-2" value={genScale} onChange={e => setGenScale(e.target.value)}>
                        <option value="major">Major</option>
                        <option value="minor">Minor</option>
                      </select>
                    </div>

                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-16 text-slate-400">Tempo</span>
                      <input
                        type="number"
                        min={50}
                        max={160}
                        className="flex-1 bg-slate-700 rounded-lg px-3 py-2"
                        value={genTempo}
                        onChange={e => setGenTempo(parseInt(e.target.value || "90"))}
                      />
                      <span className="text-slate-400">bpm</span>
                    </div>

                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-16 text-slate-400">Bars</span>
                      <input
                        type="number"
                        min={2}
                        max={32}
                        className="flex-1 bg-slate-700 rounded-lg px-3 py-2"
                        value={genBars}
                        onChange={e => setGenBars(parseInt(e.target.value || "4"))}
                      />
                    </div>

                    <div className="space-y-1">
                      <span className="text-sm text-slate-400">難易度</span>
                      <select
                        className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                        value={genDifficulty}
                        onChange={e => setGenDifficulty(parseInt(e.target.value))}
                      >
                        <option value={0}>🎯 初心者（4小節・白鍵のみ）</option>
                        <option value={1}>やさしい</option>
                        <option value={2}>ふつう</option>
                        <option value={3}>むずかしい</option>
                      </select>
                    </div>

                    <div className="space-y-1">
                      <span className="text-sm text-slate-400">パターン</span>
                      <select
                        className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        value={genType}
                        onChange={e => setGenType(e.target.value)}
                        disabled={genDifficulty !== 0}
                      >
                        <option value="random">🎲 ランダム</option>
                        <option value="twinkle">きらきら星</option>
                        <option value="butterfly">ちょうちょう</option>
                      </select>
                    </div>

                    <button
                      className="w-full px-4 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition"
                      onClick={generateAndLoad}
                      disabled={isOfflineMode}
                      title={offlineDisabledTooltip}
                    >
                      生成 → ロード
                    </button>
                  </div>
                </div>
              </aside>
            </>
          )}

          {/* 右サイド設定パネル */}
          {settingsOpen && (
            <>
              <div
                className="fixed inset-0 bg-black/60 z-40"
                onClick={() => setSettingsOpen(false)}
              />
              <aside className="fixed top-0 right-0 bottom-0 w-80 max-w-[85vw] bg-slate-800 shadow-2xl z-50 overflow-y-auto">
                <div className="p-4 space-y-4">
                  {/* ヘッダー */}
                  <div className="flex items-center justify-between border-b border-slate-700 pb-3">
                    <h2 className="text-lg font-semibold">設定</h2>
                    <button
                      className="w-8 h-8 flex items-center justify-center hover:bg-slate-700 rounded transition"
                      onClick={() => setSettingsOpen(false)}
                    >
                      ✕
                    </button>
                  </div>

                  {/* サウンド設定 */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-300">サウンド</h3>
                    <div className="space-y-1">
                      <span className="text-sm text-slate-400">音源</span>
                      <select
                        className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                        value={sound}
                        onChange={e => setSound(e.target.value)}
                        disabled={isOfflineMode}
                        title={offlineDisabledTooltip}
                      >
                        <option value="synth">Synth (軽量)</option>
                        <option value="piano">Piano</option>
                        <option value="piano-bright">Piano (Bright)</option>
                      </select>
                      <div className="text-xs text-slate-400">
                        {soundLoading ? "loading…" : instReady ? "ready" : "initializing…"}
                      </div>
                      {isOfflineMode && (
                        <div className="text-xs text-amber-200">オフライン中はSynthのみ</div>
                      )}
                    </div>
                  </div>

                  {/* 表示設定 */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-300">表示</h3>
                    
                    <div className="space-y-1">
                      <span className="text-sm text-slate-400">ラベル</span>
                      <select
                        className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm"
                        value={labelMode}
                        onChange={e => setLabelMode(e.target.value)}
                      >
                        <option value="none">非表示</option>
                        <option value="AG">A–G（英名）</option>
                        <option value="DoReMi">ドレミ</option>
                      </select>
                    </div>
                  </div>

                  {/* 再生設定 */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold text-slate-300">再生</h3>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={loopEnabled}
                        onChange={e => setLoopEnabled(e.target.checked)}
                      />
                      <span className="text-sm">ループ再生</span>
                    </label>
                  </div>

                  {/* オフライン設定 */}
                  <div className="space-y-2 border-t border-slate-700 pt-3">
                    <h3 className="text-sm font-semibold text-slate-300">オフライン</h3>
                    <div className="flex items-center gap-2 text-xs">
                      <span className={`px-2 py-1 rounded-full ${offlineReady ? "bg-emerald-600/30 text-emerald-100" : "bg-amber-600/30 text-amber-100"}`}>
                        {offlineReady ? "準備OK" : "未準備"}
                      </span>
                      {swVersion && (
                        <span className="text-slate-400">SW {swVersion}</span>
                      )}
                    </div>
                    <button
                      className="w-full px-3 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm transition"
                      onClick={handleManualPrecache}
                      disabled={precacheState.status === "running"}
                    >
                      オフライン準備を実行
                    </button>
                    {precacheState.status === "running" && (
                      <div className="text-xs text-amber-200">キャッシュ中…</div>
                    )}
                    {precacheState.status === "done" && (
                      <div className="text-xs text-emerald-300">
                        完了 ({precacheState.detail?.cached ?? 0}/{precacheState.detail?.total ?? 0})
                      </div>
                    )}
                  </div>

                  {/* 開発者メニュー */}
                  <div className="border-t border-slate-700 pt-3">
                    <button
                      className="text-xs underline decoration-dotted text-slate-400"
                      onClick={()=>setDevPanelOpen(v=>!v)}
                    >
                      開発者メニューを{devPanelOpen ? "閉じる" : "開く"}
                    </button>

                    {devPanelOpen && (
                      <div className="mt-3 space-y-3 rounded-lg bg-slate-900/40 p-3 text-xs">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600"
                            onClick={refreshCacheReport}
                          >
                            再読込
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-50 disabled:cursor-not-allowed"
                            onClick={handlePurgeCaches}
                            disabled={purgeState?.status === "running"}
                          >
                            キャッシュ全削除
                          </button>
                        </div>

                        {cacheError && (
                          <div className="text-rose-300">エラー: {cacheError}</div>
                        )}

                        <div className="space-y-2 max-h-60 overflow-auto">
                          {cacheReport.length === 0 && !cacheError && (
                            <div className="opacity-70">キャッシュなし</div>
                          )}
                          {cacheReport.map((cache) => (
                            <div key={cache.name} className="rounded bg-slate-800/70 p-2 space-y-1">
                              <div className="font-semibold">{cache.name}</div>
                              <div className="text-[11px] opacity-70">{cache.humanTotal} / {cache.entries.length} items</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </aside>
            </>
          )}
        </>
      )}

      {/* DevStatsオーバーレイ */}
      <DevStatsOverlay visible={isDevEnvironment && devPanelOpen} fps={frameStats.fps} drops={frameStats.drops} />

      {/* ライブラリモーダル */}
      {libOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-xl p-4 w-[560px] max-w-[90%] max-h-[80vh] flex flex-col">
            <div className="flex items-center mb-3">
              <h2 className="text-lg font-semibold">ライブラリ</h2>
              <button className="ml-auto w-8 h-8 flex items-center justify-center hover:bg-slate-700 rounded" onClick={() => setLibOpen(false)}>
                ✕
              </button>
            </div>
            <div className="space-y-2 overflow-auto flex-1">
              {libItems.length === 0 && <div className="opacity-70 text-sm">保存された曲はありません。</div>}
              {libItems.map(item => (
                <div key={item.id} className="flex items-center gap-2 bg-slate-700/60 rounded px-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{item.name || "(無題)"}</div>
                    <div className="text-xs opacity-70">{fmtDate(item.createdAt)}・{(item.size / 1024).toFixed(1)} KB</div>
                  </div>
                  <button className="px-3 py-2 bg-indigo-600 rounded hover:bg-indigo-500 text-sm" onClick={() => loadFromLibrary(item.id)}>
                    読込
                  </button>
                  <button className="px-3 py-2 bg-rose-700 rounded hover:bg-rose-600 text-sm" onClick={() => removeFromLibrary(item.id)}>
                    削除
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 text-right">
              <button className="px-4 py-2 bg-slate-700 rounded hover:bg-slate-600" onClick={() => setLibOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 更新通知トースト */}
      {updateToast && (
        <div className="fixed inset-x-0 bottom-4 z-50 px-4 flex justify-center">
          <div className="bg-slate-900/95 border border-slate-700 text-slate-100 rounded-2xl px-4 py-3 shadow-xl flex flex-wrap items-center gap-3 max-w-xl w-full">
            <div className="flex-1 text-sm">
              {updateToast.status === "applying"
                ? "更新を適用中です…数秒お待ちください。"
                : "新しいバージョンがあります。更新しますか？"}
            </div>
            {updateToast.status === "applying" ? (
              <span className="text-xs opacity-70">反映中…</span>
            ) : (
              <>
                <button className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500" onClick={handleUpdateNow}>
                  今すぐ更新
                </button>
                <button className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600" onClick={dismissUpdateToast}>
                  あとで
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
