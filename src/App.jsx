// App.jsx
import React, { useCallback, useEffect, useRef, useState } from "react";
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

const NOTE_MIN_HEIGHT = 10;
const SPEED = 140;     // px/sec
const KB_HEIGHT = 140; // keyboard height (px)
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
  const half = Math.floor((keyCount-1)/2);
  const min = clampMidi(centerMidi - half);
  const max = clampMidi(min + keyCount - 1);
  return { minMidi:min, maxMidi:max };
}
function analyzeNoteRangeAuto(notes){
  if(!notes.length) return { minMidi:A0_MIDI, maxMidi:C8_MIDI };
  let min=Infinity, max=-Infinity;
  for(const n of notes){ if(n.midi<min) min=n.midi; if(n.midi>max) max=n.midi; }
  min = clampMidi(min-3); max = clampMidi(max+3);
  const minWidth = 24;
  if(max-min+1 < minWidth){
    const center = (min+max)/2|0;
    return centerPresetRange(center, minWidth);
  }
  return { minMidi:min, maxMidi:max };
}

// ---------- particles / ripples / aura ----------
function spawnParticles(store, {x,y,color}, level){
  const count = level==='standard' ? 8 : 14;
  for(let i=0;i<count;i++){
    const ang = Math.random()*Math.PI - Math.PI/2;
    const speed = 60 + Math.random()*120;
    store.push({
      x,y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed-40,
      life: 0.5 + Math.random()*0.4, age:0,
      color, size: 2 + Math.random()*3, sparkle: level==='fun' && Math.random()<0.35
    });
  }
}
function spawnRipple(store, {x,y}, level){
  const count = level==='standard' ? 1 : 2;
  for(let i=0;i<count;i++){
    store.push({ x,y, radius:5, maxRadius: level==='standard'?90:130, life:1.2, age:0, alpha:0.7, delay:i*0.1 });
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

  const [noteStyle, setNoteStyle] = useState("star");
  const [effectLevel, setEffectLevel] = useState("standard"); // focus | standard | fun
  const [labelMode, setLabelMode] = useState("none"); // none | AG | DoReMi

  const [rangePreset, setRangePreset] = useState("auto");
  const [viewMinMidi, setViewMinMidi] = useState(A0_MIDI);
  const [viewMaxMidi, setViewMaxMidi] = useState(C8_MIDI);

  // --- 生成パラメータ（MVP） ---
  const [genKey, setGenKey] = useState("C");             // C,D,E,F,G,A,B
  const [genScale, setGenScale] = useState("major");     // major | minor
  const [genTempo, setGenTempo] = useState(90);          // bpm
  const [genBars, setGenBars] = useState(8);             // 小節数
  const [genDifficulty, setGenDifficulty] = useState(2); // 1..3

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
  const controllerSeenRef = useRef(
    typeof navigator !== "undefined" ? Boolean(navigator.serviceWorker?.controller) : false
  );

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

  // timing
  const playheadRef = useRef(0);
  const t0Ref = useRef(0);
  const rafIdRef = useRef(0);
  const rafActiveRef = useRef(false);
  const isPlayingRef = useRef(false);
  const prevTRef = useRef(0);

  // audio
  const masterRef = useRef(null);
  const busRef = useRef(null);
  const instrumentRef = useRef(null);

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

    setTimeout(onResize, 0);
    return ()=>{
      try{ instrumentRef.current?.inst?.dispose?.(); }catch{}
      try{ instrumentRef.current?.chain?.forEach(n=>{n.disconnect?.(); n.dispose?.();}); }catch{}
      try{ busRef.current?.disconnect?.(); busRef.current?.dispose?.(); }catch{}
      try{ masterRef.current?.disconnect?.(); masterRef.current?.dispose?.(); }catch{}
    };
  },[]);

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

  // resize
  useEffect(()=>{
    const handle=()=>onResize();
    window.addEventListener("resize", handle);
    return ()=>window.removeEventListener("resize", handle);
  },[notes, viewMinMidi, viewMaxMidi]);

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
  }

  function cancelRAF(){ rafActiveRef.current=false; if(rafIdRef.current){ cancelAnimationFrame(rafIdRef.current); rafIdRef.current=0; } }
  function startRAF(){ if(rafActiveRef.current) return; rafActiveRef.current=true; rafIdRef.current=requestAnimationFrame(draw); }

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

      keyFlashRef.current.clear();
      landedAtRef.current.clear();
      particlesRef.current = [];
      ripplesRef.current = [];
      trailsRef.current.clear();
      aurasRef.current = [];
      bgIntensityRef.current = 0;

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

  const KEY_TO_SEMITONE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  function buildScaleIntervals(scale){
    return scale==="minor" ? [0,2,3,5,7,8,10,12] : [0,2,4,5,7,9,11,12]; // 自然的短音階/長音階
  }

  function randomChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  function clampToRange(m){ return clampMidi(m); }

  async function generateAndLoad() {
    try {
      const tempo = clamp(genTempo, 50, 160);
      const bars = clamp(genBars, 2, 32);
      const difficulty = clamp(genDifficulty, 1, 3);

      const midi = new Midi();
      midi.header.setTempo(tempo);

      const tr = midi.addTrack();
      const rootSemitone = KEY_TO_SEMITONE[genKey] ?? 0;
      const scale = buildScaleIntervals(genScale);
      const rootOct = 60; // C4を基準、選んだキーにシフト

      // リズム：難易度で密度を切替
      // diff=1: 1/2音符中心, diff=2: 1/4中心, diff=3: 1/8混在
      const rhythmPool =
        difficulty===1 ? [1.0, 0.5, 0.5, 1.0] :
        difficulty===2 ? [0.5, 0.5, 0.25, 0.25, 1.0] :
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
          if(difficulty===3 && Math.random()<0.15){
            const up = Math.random()<0.5 ? -12 : 12;
            currentMidi = clampToRange(currentMidi + up);
          }
        }

        // 休符：難易度1で少なめ、3でやや多め
        const restProb = difficulty===1 ? 0.05 : difficulty===2 ? 0.1 : 0.15;
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
    let range;
    if(preset==="auto") range = analyzeNoteRangeAuto(src);
    else if(preset==="24") range = centerPresetRange(MIDDLE_C, 24);
    else if(preset==="48") range = centerPresetRange(MIDDLE_C, 48);
    else if(preset==="61") range = centerPresetRange(MIDDLE_C, 61);
    else range = { minMidi:A0_MIDI, maxMidi:C8_MIDI };
    setViewMinMidi(range.minMidi);
    setViewMaxMidi(range.maxMidi);
  }
  useEffect(()=>{ applyRangePreset(rangePreset, notes); },[rangePreset]);

  // -------- transport --------
  async function play(){
    if(!notes.length) return;
    if(!instReady || !instrumentRef.current?.inst){
      alert("音源を読み込み中です。Synth に切り替えるとすぐに再生できます。");
      return;
    }
    await Tone.start();
    cancelRAF();

    // 再生開始時に visualEnd を再計算（高さ未確定対策）
    const H = canvasSizeRef.current.H || canvasRef.current?.getBoundingClientRect().height || 0;
    recomputeVisualEnd(H, notes);

    const now = Tone.now();
    t0Ref.current = now - (playheadRef.current / rateRef.current);
    prevTRef.current = playheadRef.current;

    masterRef.current?.gain?.rampTo?.(0.9, 0.03);
    isPlayingRef.current = true;
    setIsPlaying(true);
    startRAF();
  }
  function pause(){
    cancelRAF();
    const tFreeze = isPlayingRef.current
      ? (Tone.now() - t0Ref.current) * rateRef.current
      : playheadRef.current;

    isPlayingRef.current = false;
    setIsPlaying(false);

    setPlayhead(tFreeze);
    playheadRef.current = tFreeze;
    prevTRef.current = tFreeze;

    masterRef.current?.gain?.rampTo?.(0, 0.03);
    instrumentRef.current?.inst?.releaseAll?.();

    renderFrame(tFreeze);
  }
  function stop(resetToZero=true){
    cancelRAF();
    isPlayingRef.current = false;
    setIsPlaying(false);

    const target = resetToZero ? 0 : playheadRef.current;
    setPlayhead(target);
    playheadRef.current = target;
    prevTRef.current = target;
    t0Ref.current = Tone.now() - (target / rateRef.current);

    keyFlashRef.current.clear();
    landedAtRef.current.clear();
    particlesRef.current = [];
    ripplesRef.current = [];
    trailsRef.current.clear();
    aurasRef.current = [];
    bgIntensityRef.current = 0;

    masterRef.current?.gain?.rampTo?.(0, 0.03);
    instrumentRef.current?.inst?.releaseAll?.();

    renderFrame(target);
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
    const now = Tone.now();
    let t = isPlayingRef.current ? (now - t0Ref.current)*rateRef.current : playheadRef.current;

    // 終了判定：ref優先（state遅延を回避）
    const limitVisual = endTimeRef.current;
    const limit = Math.max(durationRef.current, isFinite(limitVisual) ? limitVisual : 0) + STOP_TAIL;
    const epsilon = 1/60; // 1フレームの余裕

    if(isPlayingRef.current && limit>0 && t >= limit - epsilon){
      t = limit;
      isPlayingRef.current = false;
      setIsPlaying(false);
      setPlayhead(limit);
      playheadRef.current = limit;
      masterRef.current?.gain?.rampTo?.(0, 0.03);
      instrumentRef.current?.inst?.releaseAll?.();
      renderFrame(limit);
      cancelRAF();
      return;
    }

    if(isPlayingRef.current){ setPlayhead(t); playheadRef.current = t; }
    renderFrame(t);

    if(rafActiveRef.current) rafIdRef.current = requestAnimationFrame(draw);
  }

  // 半音等間隔のX計算
  function keyCountVisible(){ return Math.max(1, (viewMaxMidi - viewMinMidi + 1)); }
  function xForMidi(midi, W){ return ((midi - viewMinMidi) / keyCountVisible()) * W; }
  function keyWidth(W){ return W / keyCountVisible(); }

  function renderFrame(t){
    const c = canvasRef.current; if(!c) return;
    const ctx = c.getContext("2d");
    const { W, H } = canvasSizeRef.current;
    if(!W || !H) return;

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

    const wKey = keyWidth(W);

    // ----- NOTES（鍵盤の上に出ないようクリップ） -----
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, keylineY);
    ctx.clip();

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
          const xCenter = xForMidi(n.midi, W) + wKey/2;
          const pc = isWhite(n.midi) ? COLORS.particleWhite : COLORS.particleBlack;
          if(effectLevel==="standard"){
            spawnRipple(ripplesRef.current, {x:xCenter, y:keylineY}, "standard");
          }else{
            bgIntensityRef.current = Math.min(1, bgIntensityRef.current + (n.vel||0.9)*0.3);
            const hue = 210 - (clamp(n.midi, A0_MIDI, C8_MIDI)-A0_MIDI) * ((210-55)/KEY_COUNT);
            const width = 6 + (n.vel||0.9)*12;
            const life  = 1.4 + (n.vel||0.9)*0.4;
            aurasRef.current.push({ x:xCenter, y:keylineY, hue, width, life, age:0 });
            spawnRipple(ripplesRef.current, {x:xCenter, y:keylineY}, "fun");
            spawnParticles(particlesRef.current, {x:xCenter, y:keylineY, color:pc}, "fun");
          }
        }
      }

      // 可視レンジ外
      const inView = (n.midi >= viewMinMidi-1 && n.midi <= viewMaxMidi+1);
      if(!inView) { trailsRef.current.delete(n.i); continue; }
      if(yTop>H || yBottom<0){ trailsRef.current.delete(n.i); continue; }

      const x = xForMidi(n.midi, W);

      // トレイル
      if(effectLevel!=="focus" && isPlayingRef.current && yTop>=0 && yTop<=keylineY){
        if(!trailsRef.current.has(n.i)) trailsRef.current.set(n.i, []);
        const trail = trailsRef.current.get(n.i);
        trail.push({ x: x + wKey/2, y: yTop + h/2, time: t, color: isWhite(n.midi) ? COLORS.trailWhite : COLORS.trailBlack });
        if(trail.length>8) trail.shift();
      }

      const landedAt = landedAtRef.current.get(n.i);
      const litUntil = landedAt!=null ? (landedAt + Math.max(MIN_LIT_SEC, durSec/rateRef.current)) : 0;
      const isLit = landedAt!=null && t <= litUntil + 0.02;

      const isW = isWhite(n.midi);
      const fill = isW ? (isLit?COLORS.noteWhiteActive:COLORS.noteWhite) : (isLit?COLORS.noteBlackActive:COLORS.noteBlack);
      drawNote(ctx, noteStyle, { x:x+1, y:yTop, w:Math.max(1,wKey-2), h, color:fill });
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
  }

  function drawNote(ctx, style, box){
    const {x,y,w,h,color} = box;
    ctx.fillStyle = color;

    const drawRectOnly = (effectLevel==="focus");
    if(drawRectOnly || style==="rect"){
      const r = Math.min(6, w*0.3);
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y, x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x, y+h, r);
      ctx.arcTo(x, y+h, x, y, r);
      ctx.arcTo(x, y, x+w, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }

    const r = Math.min(6, w*0.3);
    ctx.beginPath();
    ctx.moveTo(x+r, y);
    ctx.arcTo(x+w, y, x+w, y+h, r);
    ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r);
    ctx.arcTo(x, y, x+w, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const cx = x + w/2, cy = y + Math.min(h*0.35, 18);
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.strokeStyle = "rgba(0,0,0,0.15)";
    ctx.lineWidth = 1;
    if(style==="star") drawStar(ctx, cx, cy, Math.min(w,h*0.4)/2, 5);
    else drawHeart(ctx, cx, cy, Math.min(w,h*0.4)/2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
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
      const alpha = (1 - progress) * 0.9;
      const topY = keylineY - 220;
      const grd = ctx.createLinearGradient(a.x, keylineY, a.x, topY);
      grd.addColorStop(0, `hsla(${a.hue},90%,65%,${alpha})`);
      grd.addColorStop(1, `hsla(${a.hue},90%,65%,0)`);
      ctx.fillStyle = grd;
      const w = a.width * (1 + 0.2*Math.sin(a.age*6));
      ctx.fillRect(a.x - w/2, topY, w, keylineY-topY);

      const rg = ctx.createRadialGradient(a.x, keylineY, 0, a.x, keylineY, 28);
      rg.addColorStop(0, `hsla(${a.hue},90%,75%,${alpha*0.5})`);
      rg.addColorStop(1, `hsla(${a.hue},90%,75%,0)`);
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(a.x, keylineY, 28, 0, Math.PI*2); ctx.fill();
    }
  }

  // 半音等間隔の鍵盤
  function drawKeyboardUniform(ctx, x, y, w, h, t, allNotes, minMidi, maxMidi, labelMode){
    const keyW = keyWidth(w);

    ctx.fillStyle = COLORS.keyShadow; ctx.fillRect(x, y-6, w, 6);

    // 白鍵
    for(let m=minMidi; m<=maxMidi; m++){
      if(!isWhite(m)) continue;
      const keyX = xForMidi(m, w);
      ctx.fillStyle = COLORS.whiteKey;
      ctx.fillRect(keyX, y, keyW-1, h);
      ctx.strokeStyle = COLORS.keyBorder;
      ctx.strokeRect(keyX, y, keyW-1, h);
    }
    // 黒鍵
    for(let m=minMidi; m<=maxMidi; m++){
      if(isWhite(m)) continue;
      const keyX = xForMidi(m, w);
      const blackW = keyW * 0.7;
      const blackH = h * 0.62;
      const bx = keyX + (keyW - blackW)/2;
      ctx.fillStyle = COLORS.blackKey;
      ctx.fillRect(bx, y, blackW, blackH);
    }

    // アクティブ
    const active = new Set();
    for(const [id, landedAt] of landedAtRef.current){
      const n = allNotes[id]; if(!n) continue;
      if(n.midi < minMidi || n.midi > maxMidi) continue;
      const litUntil = landedAt + Math.max(MIN_LIT_SEC, (n.end-n.start)/rateRef.current);
      if(t<=litUntil+0.02) active.add(n.midi);
    }
    for(const midi of active){
      const keyX = xForMidi(midi, w);
      const isW = isWhite(midi);
      const flashEnd = keyFlashRef.current.get(midi) ?? 0;
      const flashDur = (FLASH_MS/1000)/rateRef.current;
      const flashAlpha = Math.max(0, Math.min(1, (flashEnd - t)/flashDur));
      const base = isW ? COLORS.keyActiveWhite : COLORS.keyActiveBlack;
      ctx.fillStyle = base;
      if(isW){
        ctx.globalAlpha = 0.35; ctx.fillRect(keyX, y, keyW-1, h);
        if(flashAlpha>0){ ctx.globalAlpha = 0.35 + 0.35*flashAlpha; ctx.fillRect(keyX, y, keyW-1, h); }
      }else{
        const blackW = keyW*0.7, blackH=h*0.62, bx=keyX+(keyW-blackW)/2;
        ctx.globalAlpha = 0.4; ctx.fillRect(bx, y, blackW, blackH);
        if(flashAlpha>0){ ctx.globalAlpha = 0.4 + 0.35*flashAlpha; ctx.fillRect(bx, y, blackW, blackH); }
      }
      ctx.globalAlpha = 1;
    }

    // Cマーカー
    ctx.save();
    for(let m=minMidi; m<=maxMidi; m++){
      if(m%12!==0) continue;
      const keyX = xForMidi(m, w);
      const cx = keyX + keyW/2;
      const isC4 = (m===MIDDLE_C);
      ctx.strokeStyle = isC4?COLORS.markerC4:COLORS.markerC;
      ctx.lineWidth = isC4?3:2;
      ctx.beginPath(); ctx.moveTo(cx, y-6); ctx.lineTo(cx, y-1); ctx.stroke();
      if(isC4){
        ctx.fillStyle = "rgba(251,191,36,0.2)";
        ctx.beginPath(); ctx.arc(cx, y-10, 10, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle = COLORS.markerC4; ctx.font = "bold 10px ui-sans-serif, system-ui"; ctx.textAlign="center";
        ctx.fillText("C4", cx, y-10);
      }
    }
    ctx.restore();

    // ラベル
    if(labelMode!=="none"){
      ctx.save();
      ctx.fillStyle = COLORS.label;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "11px ui-sans-serif, system-ui";
      for(let m=minMidi; m<=maxMidi; m++){
        if(!isWhite(m)) continue;
        const keyX = xForMidi(m, w);
        const cx = keyX + keyW/2;
        const { name, octave } = (labelMode==="AG") ? nameAG(m) : nameDoReMi(m);
        const text = (labelMode==="AG") ? `${name}${octave}` : name;
        ctx.fillText(text, cx, y + h - 12);
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
  const totalDuration = Math.max(durationRef.current, isFinite(endTimeRef.current)?endTimeRef.current:0);
  const progressRatio = totalDuration>0 ? Math.min(1, playhead/totalDuration) : 0;
  const progressPercent = Math.round(progressRatio*100);
  const offlineDisabledTooltip = isOfflineMode ? "オフラインでは使えません" : undefined;
  const onlineStatusLabel = isOfflineMode ? "🔴オフライン" : "🟢オンライン";
  const onlineStatusClass = isOfflineMode
    ? "bg-rose-600/20 text-rose-200 border border-rose-500/40"
    : "bg-emerald-600/20 text-emerald-200 border border-emerald-500/40";


  return (

    <div className="min-h-screen bg-slate-900 text-slate-100">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-16">
        <div className="sticky top-0 z-30 -mx-4 sm:-mx-6 px-4 sm:px-6 pt-6 pb-4 space-y-4 bg-slate-900/95 backdrop-blur border-b border-slate-800">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <h1 className="text-xl sm:text-2xl font-semibold leading-tight">🎹 Falling Notes Piano – 視認性UP & 教育特化版</h1>
            <div className="text-xs sm:text-sm text-slate-300 truncate">{name || "No file loaded"}</div>
          </div>
          <div className="flex items-center gap-2 text-xs sm:text-sm">
            <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full font-medium ${onlineStatusClass}`}>
              {onlineStatusLabel}
            </span>
            {isOfflineMode ? (
              <span className="text-[11px] sm:text-xs text-amber-200">
                オフライン中は生成・外部音源・読み込み機能が自動停止します。
              </span>
            ) : (
              <span className="text-[11px] sm:text-xs text-slate-400">
                ネットワーク接続で生成・外部音源の利用が可能です。
              </span>
            )}
          </div>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="flex-1 sm:flex-none min-h-[44px] px-5 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
                disabled={!notes.length || isPlaying || !instReady}
                onClick={play}
              >
                Play
              </button>
              <button
                className="flex-1 sm:flex-none min-h-[44px] px-5 py-3 rounded-2xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
                disabled={!isPlaying}
                onClick={pause}
              >
                Pause
              </button>
              <button
                className="flex-1 sm:flex-none min-h-[44px] px-5 py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
                disabled={!notes.length}
                onClick={() => stop(true)}
              >
                Stop
              </button>
              <div className="basis-full sm:basis-auto sm:ml-auto text-xs sm:text-sm text-slate-300">
                再生速度 {Math.round(rate * 100)}%
              </div>

            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-slate-300">
                <span>Progress</span>
                <span className="ml-auto font-mono text-sm">{fmt(playhead)} / {fmt(totalDuration)}</span>
                <span className="basis-full text-[11px] text-slate-400">完了 {progressPercent}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5 pt-6">
          {isOfflineMode && (
            <div className="text-sm text-amber-200 bg-amber-900/20 border border-amber-400/40 rounded-xl px-4 py-3">
              現在オフラインです。外部音源と生成機能は一時的に無効になります。
            </div>
          )}

          <details className="rounded-2xl bg-slate-800/70 shadow-lg">
            <summary className="flex items-center justify-between min-h-[44px] cursor-pointer select-none px-4 sm:px-6 py-3 text-lg font-semibold">
              <span>設定</span>
              <span className="text-sm font-normal opacity-70">タップして開く</span>
            </summary>
            <div className="border-t border-slate-700/60 px-4 sm:px-6 py-4 space-y-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
                  <label
                    className={`inline-flex items-center justify-center w-full sm:w-auto min-h-[44px] px-5 py-3 rounded-2xl transition shadow-sm ${
                      isOfflineMode
                        ? "bg-slate-700 opacity-60 cursor-not-allowed"
                        : "bg-slate-700 hover:bg-slate-600 cursor-pointer"
                    }`}
                    title={offlineDisabledTooltip}
                    aria-disabled={isOfflineMode}
                  >
                    Choose MIDI
                    <input
                      type="file"
                      accept=".mid,.midi"
                      className="hidden"
                      onChange={onFile}
                      disabled={isOfflineMode}
                    />
                  </label>

                  <div className="flex items-center gap-2 text-sm bg-slate-900/20 rounded-2xl px-3 py-2 sm:px-4">
                    <span className="opacity-80">Key</span>
                    <select className="bg-slate-700 rounded-xl px-3 h-11" value={genKey} onChange={e => setGenKey(e.target.value)}>
                      {["C", "D", "E", "F", "G", "A", "B"].map(k => (
                        <option key={k} value={k}>
                          {k}
                        </option>
                      ))}
                    </select>
                    <select className="bg-slate-700 rounded-xl px-3 h-11" value={genScale} onChange={e => setGenScale(e.target.value)}>
                      <option value="major">Major</option>
                      <option value="minor">Minor</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2 text-sm bg-slate-900/20 rounded-2xl px-3 py-2 sm:px-4">
                    <span className="opacity-80">Tempo</span>
                    <input
                      type="number"
                      min={50}
                      max={160}
                      className="w-full sm:w-24 bg-slate-700 rounded-xl px-3 h-11"
                      value={genTempo}
                      onChange={e => setGenTempo(parseInt(e.target.value || "90"))}
                    />
                    <span className="opacity-60 text-xs">bpm</span>
                  </div>


                  <div className="flex items-center gap-2 text-sm bg-slate-900/20 rounded-2xl px-3 py-2 sm:px-4">
                    <span className="opacity-80">Bars</span>
                    <input
                      type="number"
                      min={2}
                      max={32}
                      className="w-full sm:w-24 bg-slate-700 rounded-xl px-3 h-11"
                      value={genBars}
                      onChange={e => setGenBars(parseInt(e.target.value || "8"))}
                    />
                  </div>


                  <div className="flex items-center gap-2 text-sm bg-slate-900/20 rounded-2xl px-3 py-2 sm:px-4">
                    <span className="opacity-80">難易度</span>
                    <select
                      className="bg-slate-700 rounded-xl px-3 h-11"
                      value={genDifficulty}
                      onChange={e => setGenDifficulty(parseInt(e.target.value))}
                    >
                      <option value={1}>やさしい</option>
                      <option value={2}>ふつう</option>
                      <option value={3}>むずかしい</option>
                    </select>
                  </div>


                  <button
                    className="w-full sm:w-auto min-h-[44px] px-5 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
                    onClick={generateAndLoad}
                    disabled={isOfflineMode}
                    title={offlineDisabledTooltip}
                  >
                    生成 → ロード
                  </button>

                  <button
                    className="w-full sm:w-auto min-h-[44px] px-5 py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm transition"
                    onClick={handleSave}
                    disabled={!notes.length}
                  >
                    保存
                  </button>

                  <button
                    className="w-full sm:w-auto min-h-[44px] px-5 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 shadow-sm transition"
                    onClick={openLibrary}
                  >
                    ライブラリ
                  </button>
                </div>
                {isOfflineMode && (
                  <div className="text-xs text-amber-200">
                    オフライン中は生成と外部音源の読み込みは行えません。オンラインに戻ると自動で再開します。
                  </div>
                )}
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 text-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="opacity-80">Speed</span>
                    <select
                      className="w-full sm:w-auto bg-slate-700 rounded-xl px-3 h-11"
                      value={rate}
                      onChange={e => setRate(parseFloat(e.target.value))}
                    >
                      {speedOptions.map(v => (
                        <option key={v} value={v}>
                          {Math.round(v * 100)}%
                        </option>
                      ))}
                    </select>
                  </div>


                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="opacity-80">Sound</span>
                    <select
                      className="w-full sm:w-auto bg-slate-700 rounded-xl px-3 h-11 disabled:opacity-50 disabled:cursor-not-allowed"
                      value={sound}
                      onChange={e => setSound(e.target.value)}
                      disabled={isOfflineMode}
                      title={offlineDisabledTooltip}
                    >
                      <option value="synth">Synth (軽量)</option>
                      <option value="piano">Piano</option>
                      <option value="piano-bright">Piano (Bright)</option>
                    </select>
                    {soundLoading ? (
                      <span className="text-xs opacity-70">loading…</span>
                    ) : instReady ? (
                      <span className="text-xs opacity-70">ready</span>
                    ) : (
                      <span className="text-xs opacity-70">initializing…</span>
                    )}
                    {isOfflineMode && <span className="text-xs text-amber-200">オフライン中はSynthのみ利用できます</span>}
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="opacity-80">Notes</span>
                    <select
                      className="w-full sm:w-auto bg-slate-700 rounded-xl px-3 h-11"
                      value={noteStyle}
                      onChange={e => setNoteStyle(e.target.value)}
                    >
                      <option value="rect">Rectangle</option>
                      <option value="star">⭐ Star</option>
                      <option value="heart">❤️ Heart</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="opacity-80">鍵盤範囲</span>
                    <select
                      className="w-full sm:w-auto bg-slate-700 rounded-xl px-3 h-11"
                      value={rangePreset}
                      onChange={e => setRangePreset(e.target.value)}
                    >
                      <option value="auto">Auto（楽曲解析）</option>
                      <option value="24">24鍵（幼児）</option>
                      <option value="48">48鍵（小学生）</option>
                      <option value="61">61鍵（標準）</option>
                      <option value="88">88鍵（フル）</option>
                    </select>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <span className="opacity-80">ラベル</span>
                    <select
                      className="w-full sm:w-auto bg-slate-700 rounded-xl px-3 h-11"
                      value={labelMode}
                      onChange={e => setLabelMode(e.target.value)}
                    >
                      <option value="none">非表示</option>
                      <option value="AG">A–G（英名）</option>
                      <option value="DoReMi">ドレミ</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="opacity-80 font-medium">Effect:</span>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="effectLevel"
                        value="focus"
                        checked={effectLevel === "focus"}
                        onChange={e => setEffectLevel(e.target.value)}
                      />
                      🎯 集中
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="effectLevel"
                        value="standard"
                        checked={effectLevel === "standard"}
                        onChange={e => setEffectLevel(e.target.value)}
                      />
                      ✨ 標準
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="radio"
                        name="effectLevel"
                        value="fun"
                        checked={effectLevel === "fun"}
                        onChange={e => setEffectLevel(e.target.value)}
                      />
                      🎉 楽しさ
                    </label>
                  </div>
                </div>
              </div>

            </div>
          </details>

          <div style={{ height: 520, border: "1px solid #334155", borderRadius: 12, overflow: "hidden" }}>
            <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />
          </div>

          <p className="text-xs opacity-70">
            🎯集中＝鍵盤発光＋落下ノートのみ／✨標準＝リップルのみ／🎉楽しさ＝光柱＆スパーク＋リップル。<br />
            生成：Key/長短/テンポ/小節/難易度 を選んで「生成 → ロード」。キー: 1=20% … 9=90%, 0=100%。
          </p>
          <div className="border-t border-slate-700 pt-3 space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">オフライン準備</span>
              <span
                className={`px-2 py-0.5 rounded-full text-xs ${offlineReady ? "bg-emerald-600/30 text-emerald-100" : "bg-amber-600/30 text-amber-100"}`}
              >
                {offlineReady ? "OK" : "未準備"}
              </span>
              {offlineStatusDetail?.missing?.length ? (
                <span className="text-xs text-amber-200">不足 {offlineStatusDetail.missing.length} 件</span>
              ) : (
                <span className="text-xs opacity-70">必須ファイルは取得済み</span>
              )}
              {offlineStatusDetail?.error && (
                <span className="text-xs text-rose-300">{offlineStatusDetail.error}</span>
              )}
              {swVersion && (
                <span className="ml-auto text-xs opacity-70">SW {swVersion}</span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleManualPrecache}
                disabled={precacheState.status === "running"}
              >
                オフライン準備を手動実行
              </button>
              {precacheState.status === "running" && (
                <span className="text-xs text-amber-200">キャッシュ中…</span>
              )}
              {precacheState.status === "done" && (
                <span className="text-xs text-emerald-300">
                  完了 ({precacheState.detail?.cached ?? 0}/{precacheState.detail?.total ?? 0})
                </span>
              )}
              {precacheState.status === "error" && (
                <span className="text-xs text-rose-300">失敗しました</span>
              )}
            </div>

            <div className="text-xs">
              <button
                className="underline decoration-dotted"
                onClick={()=>setDevPanelOpen(v=>!v)}
              >
                開発者メニューを{devPanelOpen ? "閉じる" : "開く"}
              </button>
            </div>

            {devPanelOpen && (
              <div className="space-y-3 rounded-2xl bg-slate-900/40 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
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
                  {purgeState?.status === "running" && (
                    <span className="text-amber-200">削除中…</span>
                  )}
                  {purgeState?.status === "done" && (
                    <span className="text-emerald-300">削除完了 ({purgeState.detail?.deleted ?? 0})</span>
                  )}
                  {purgeState?.status === "error" && (
                    <span className="text-rose-300">削除失敗</span>
                  )}
                </div>

                {cacheError && (
                  <div className="text-rose-300">キャッシュ取得に失敗しました: {cacheError}</div>
                )}

                <div className="space-y-2 max-h-60 overflow-auto pr-1">
                  {cacheReport.length === 0 && !cacheError && (
                    <div className="opacity-70">キャッシュは存在しません。</div>
                  )}
                  {cacheReport.map((cache) => (
                    <div key={cache.name} className="rounded-xl bg-slate-800/70 p-2 space-y-1">
                      <div className="font-semibold">{cache.name}</div>
                      <div className="text-[11px] opacity-70">{cache.humanTotal} / {cache.entries.length} items</div>
                      <ul className="space-y-1 max-h-28 overflow-auto pr-1">
                        {cache.entries.map((entry) => {
                          let label = entry.url;
                          if (typeof window !== "undefined") {
                            try {
                              const parsed = new URL(entry.url);
                              label = parsed.pathname + parsed.search;
                            } catch {}
                          }
                          return (
                            <li key={entry.url} className="flex items-center gap-2 text-[11px]">
                              <span className="flex-1 truncate">{label}</span>
                              <span className="opacity-70 whitespace-nowrap">{entry.humanSize}</span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </div>

                {offlineStatusDetail?.missing?.length > 0 && (
                  <div>
                    <div className="font-semibold">不足中の必須ファイル</div>
                    <ul className="list-disc list-inside space-y-1">
                      {offlineStatusDetail.missing.map((item) => (
                        <li key={item} className="opacity-80">{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {offlineStatusDetail?.uncachedHints?.length > 0 && (
                  <div>
                    <div className="font-semibold">未キャッシュのアセット候補</div>
                    <ul className="list-disc list-inside space-y-1">
                      {offlineStatusDetail.uncachedHints.map((item) => (
                        <li key={item} className="opacity-80">{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {libOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-xl p-4 w-[560px] max-w-[90%]">
            <div className="flex items-center mb-2">
              <div className="font-semibold">ライブラリ</div>
              <button className="ml-auto px-2 py-1 bg-slate-700 rounded" onClick={() => setLibOpen(false)}>
                ✕
              </button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-auto">
              {libItems.length === 0 && <div className="opacity-70 text-sm">保存された曲はありません。</div>}
              {libItems.map(item => (
                <div key={item.id} className="flex items-center gap-2 bg-slate-700/60 rounded px-3 py-2">
                  <div className="flex-1">
                    <div className="font-medium">{item.name || "(無題)"}</div>
                    <div className="text-xs opacity-70">{fmtDate(item.createdAt)}・{(item.size / 1024).toFixed(1)} KB</div>
                  </div>
                  <button className="px-3 py-2 bg-indigo-600 rounded hover:bg-indigo-500" onClick={() => loadFromLibrary(item.id)}>
                    読込
                  </button>
                  <button className="px-3 py-2 bg-rose-700 rounded hover:bg-rose-600" onClick={() => removeFromLibrary(item.id)}>
                    削除
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 text-right">
              <button className="px-4 py-2 bg-slate-700 rounded" onClick={() => setLibOpen(false)}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

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
                <button
                  className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500"
                  onClick={handleUpdateNow}
                >
                  今すぐ更新
                </button>
                <button
                  className="px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600"
                  onClick={dismissUpdateToast}
                >
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
