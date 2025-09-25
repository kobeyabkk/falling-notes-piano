/* 変更点（わかりやすいメモ）
 * - 左手伴奏を追加：none / bass / block / alberti（UIで選択）
 * - 生成関数が右手メロディ＋左手パターンをまとめてMIDI化
 * - 保存メタに leftHand を追加（ライブラリ表示にも反映）
 */

import React, { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { listSongs, saveSong, loadSongBytes, removeSong } from "./db";

/**
 * Falling Notes Piano – 視認性UP & 教育特化版（安定化＋エラーハンドリング強化）
 */

const KEY_COUNT = 88;
const A0_MIDI = 21;
const C8_MIDI = A0_MIDI + KEY_COUNT - 1;
const MIDDLE_C = 60;

const NOTE_MIN_HEIGHT = 10;
const SPEED = 140;     // px/sec
const KB_HEIGHT = 140; // keyboard height (px)
const VISUAL_MAX_SEC = 2.5;
const STOP_TAIL = 1.0;

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

// ---------- 生成（ルールベースV0）補助 ----------
const KEY_OFFSETS = { C:0, "C#":1, Db:1, D:2, "D#":3, Eb:3, E:4, F:5, "F#":6, Gb:6, G:7, "G#":8, Ab:8, A:9, "A#":10, Bb:10, B:11 };
const MAJOR_SCALE = [0,2,4,5,7,9,11];
const pick = (arr, probs)=> {
  if(!probs){ return arr[(Math.random()*arr.length)|0]; }
  const r = Math.random(); let acc=0;
  for(let i=0;i<arr.length;i++){ acc += probs[i] ?? 0; if(r<=acc) return arr[i]; }
  return arr[arr.length-1];
};
const quantizeToScale = (midi, rootOffset) => {
  const degs = MAJOR_SCALE.map(x => (rootOffset + x) % 12);
  let best = midi, bestD = 999;
  for(const d of degs){
    const base = Math.round((midi - d)/12)*12 + d;
    const cand = [base-12, base, base+12];
    for(const c of cand){
      const diff = Math.abs(c - midi);
      if(diff < bestD){ bestD = diff; best = c; }
    }
  }
  return best;
};

// 左手：簡易コード進行（I–V–vi–IV）をキーに合わせて移調
function chordRootsForBar(barIndex){
  const prog = [0, 7, 9, 5]; // C基準: C(0), G(7), A(9), F(5)
  return prog[barIndex % prog.length];
}
function triadSemitones(rootSemitone){
  // メジャーキー内の I, V, vi, IV をメジャー/マイナー適宜（viはマイナー）
  // ここでは「度数から推定」で簡略化
  const degree = (rootSemitone % 12 + 12) % 12;
  const isMinor = (degree === 9); // viのみ
  return isMinor ? [0, 3, 7] : [0, 4, 7];
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
  const durationRef = useRef(0);
  const [visualEnd, setVisualEnd] = useState(0);
  const endTimeRef = useRef(Infinity);

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

  // 生成パラメータ
  const [genKey, setGenKey] = useState("C");
  const [genTempo, setGenTempo] = useState(90);
  const [genBars, setGenBars] = useState(8);
  const [genDensity, setGenDensity] = useState("mid");
  const [genMaxVoices, setGenMaxVoices] = useState(1);
  const [leftHand, setLeftHand] = useState("none"); // none | bass | block | alberti

  // library UI
  const [libOpen, setLibOpen] = useState(false);
  const [libItems, setLibItems] = useState([]);

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
  const keyFlashRef = useRef(new Map());
  const landedAtRef = useRef(new Map());

  // visuals
  const particlesRef = useRef([]);
  const ripplesRef = useRef([]);
  const trailsRef = useRef(new Map());
  const aurasRef = useRef([]);
  const bgIntensityRef = useRef(0);

  // size cache
  const canvasSizeRef = useRef({ W:0, H:0 });

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
  },[sound, audioReady]);

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

  function recomputeVisualEnd(H, src){
    if(!H || !src.length){
      setVisualEnd(0);
      endTimeRef.current = Infinity;
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
    endTimeRef.current = maxT;
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
      durationRef.current = dur;
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

  // ====== 生成（右手メロディ＋左手伴奏） ======
  function toArrayBufferFromU8(u8){
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  function buildRuleBasedSequence({key="C", tempo=90, bars=8, density="mid", maxVoices=1, rangePresetForGen="auto", leftHand="none"}){
    const rootOffset = KEY_OFFSETS[key] ?? 0;
    const stepsPerBar = 16; // 16分
    const totalSteps = bars * stepsPerBar;

    // 右手メロディ設定
    const durChoices = {
      low:  [8,4,2],
      mid:  [4,2,8],
      high: [2,4,1]
    };
    const durProbs = {
      low:  [0.55,0.35,0.10],
      mid:  [0.45,0.40,0.15],
      high: [0.55,0.35,0.10]
    };
    const voicesProb = (maxVoices===2) ? 0.2 : 0.0;

    // レンジ（右手：C4–C6、左手：C2–C4 目安）
    const rightRange = {minMidi: clampMidi(MIDDLE_C), maxMidi: clampMidi(MIDDLE_C+24)};
    const leftRange  = {minMidi: clampMidi(36), maxMidi: clampMidi(60)}; // C2(36)–C4(60)

    // 右手生成
    let cur = 60 + rootOffset;
    const eventsR = [];
    let tStep = 0;
    while(tStep < totalSteps){
      const d = pick(durChoices[density] || durChoices.mid, durProbs[density] || durProbs.mid);
      const move = pick([-4,-2,0,2,4,5,7], [0.12,0.18,0.24,0.18,0.12,0.08,0.08]);
      let next = cur + move;
      next = quantizeToScale(next, rootOffset);
      next = clamp(next, rightRange.minMidi, rightRange.maxMidi);
      if(Math.abs(next-cur) > 7 && Math.random() < 0.8){ continue; }

      const vel = 0.82 + Math.random()*0.15;
      eventsR.push({ start:tStep, dur:d, pitch:next, vel });

      if(maxVoices===2 && Math.random()<voicesProb){
        const harm = clamp(quantizeToScale(next + pick([4,7,-5]), rootOffset), rightRange.minMidi, rightRange.maxMidi);
        eventsR.push({ start:tStep, dur:d, pitch:harm, vel:Math.max(0.6, vel-0.1) });
      }

      cur = next;
      tStep += d;
    }

    // 左手生成（バー単位の進行）
    const eventsL = [];
    const barSteps = stepsPerBar;
    for(let bar=0; bar<bars; bar++){
      const chordRootSemitone = (chordRootsForBar(bar) + rootOffset) % 12;
      // 近いオクターブに寄せてからC2–C4に収める
      let rootMidi = quantizeToScale(48 + chordRootSemitone, chordRootSemitone); // だいたいC3帯
      while(rootMidi < leftRange.minMidi) rootMidi += 12;
      while(rootMidi > leftRange.maxMidi-12) rootMidi -= 12;

      const triad = triadSemitones(chordRootSemitone).map(s=>rootMidi + s);
      const t0 = bar * barSteps;

      if(leftHand === "bass"){
        // ルートの4分刻み
        for(let s=0; s<stepsPerBar; s+=4){
          eventsL.push({ start:t0+s, dur:4, pitch:rootMidi, vel:0.7 });
        }
      }else if(leftHand === "block"){
        // ブロック和音（2拍ごと）
        for(let s=0; s<stepsPerBar; s+=8){
          for(const p of triad){
            eventsL.push({ start:t0+s, dur:8, pitch:clamp(p, leftRange.minMidi, leftRange.maxMidi), vel:0.68 });
          }
        }
      }else if(leftHand === "alberti"){
        // アルベルティ（低-高-中-高 を8分で繰り返し）
        const [low, mid, high] = [triad[0], triad[1], triad[2]].sort((a,b)=>a-b);
        for(let s=0; s<stepsPerBar; s+=2*4){ // 1拍=4ステップ（16分×4） → 8分=2ステップ
          const pat = [low, high, mid, high];
          for(let i=0;i<pat.length;i++){
            eventsL.push({ start:t0 + s + i*2, dur:2, pitch:clamp(pat[i], leftRange.minMidi, leftRange.maxMidi), vel:0.68 });
          }
        }
      }else{
        // none：何もしない
      }
    }

    // 16分単位 → 秒換算
    const qPerSec = tempo / 60;
    const stepSec = (1/4) / qPerSec; // 16分の長さ
    const toSec = e => ({
      time: e.start*stepSec,
      duration: Math.max(0.1, e.dur*stepSec),
      midi: e.pitch,
      velocity: e.vel
    });

    return [...eventsR.map(toSec), ...eventsL.map(toSec)];
  }

  async function generateAndLoad() {
    try {
      const events = buildRuleBasedSequence({
        key: genKey,
        tempo: genTempo,
        bars: genBars,
        density: genDensity,
        maxVoices: genMaxVoices,
        rangePresetForGen: rangePreset,
        leftHand
      });

      const midi = new Midi();
      midi.header.setTempo(genTempo);
      const tr = midi.addTrack();
      for(const ev of events){
        tr.addNote({ midi: ev.midi, time: ev.time, duration: ev.duration, velocity: ev.velocity });
      }

      const bytes = midi.toArray();
      await loadMidiFromBytes(toArrayBufferFromU8(bytes));
      setName(`Generated_${genKey}_${genTempo}bpm_${genBars}bars_${leftHand}.mid`);
    } catch (e) {
      console.error(e);
      alert("サンプル曲の生成に失敗しました。");
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

    const metaSettings = {
      key: genKey, tempo: genTempo, bars: genBars, density: genDensity, maxVoices: genMaxVoices,
      rangePreset, leftHand
    };

    await saveSong(nm, bytes, metaSettings);
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

    const limitVisual = endTimeRef.current;
    const limit = Math.max(durationRef.current, isFinite(limitVisual) ? limitVisual : 0) + STOP_TAIL;
    const epsilon = 1/60;

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

      // 発音判定
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

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <h1 className="text-2xl font-semibold">🎹 Falling Notes Piano – 視認性UP & 教育特化版</h1>

        <div className="bg-slate-800 rounded-2xl p-4 shadow space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-block px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 cursor-pointer">
              Choose MIDI
              <input type="file" accept=".mid,.midi" className="hidden" onChange={onFile}/>
            </label>

            <button
              className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500"
              onClick={generateAndLoad}
            >
              作曲（サンプル）
            </button>

            <button
              className="px-3 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600"
              onClick={handleSave}
              disabled={!notes.length}
            >
              保存
            </button>
            <button
              className="px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600"
              onClick={openLibrary}
            >
              ライブラリ
            </button>

            <div className="text-sm opacity-80 truncate">{name || "No file loaded"}</div>

            <div className="ml-auto flex items-center gap-2 text-sm">
              <span className="opacity-80">Speed</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={rate}
                onChange={(e)=>setRate(parseFloat(e.target.value))}>
                {speedOptions.map(v=>(
                  <option key={v} value={v}>{Math.round(v*100)}%</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-80">Sound</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={sound}
                onChange={(e)=>setSound(e.target.value)}>
                <option value="synth">Synth (軽量)</option>
                <option value="piano">Piano</option>
                <option value="piano-bright">Piano (Bright)</option>
              </select>
              {soundLoading
                ? <span className="text-xs opacity-70">loading…</span>
                : instReady
                  ? <span className="text-xs opacity-70">ready</span>
                  : <span className="text-xs opacity-70">initializing…</span>
              }
            </div>

            <div className="flex items-center gap-2 text-sm">
              <span className="opacity-80">Notes</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={noteStyle}
                onChange={(e)=>setNoteStyle(e.target.value)}>
                <option value="rect">Rectangle</option>
                <option value="star">⭐ Star</option>
                <option value="heart">❤️ Heart</option>
              </select>
            </div>
          </div>

          {/* 生成パラメータ UI */}
          <div className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="opacity-80">調</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={genKey}
                onChange={(e)=>setGenKey(e.target.value)}>
                {["C","D","E","F","G","A","B","Bb","Eb","F#"].map(k=><option key={k} value={k}>{k} major</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-80">テンポ</span>
              <input type="number" min={60} max={140} step={5}
                className="w-20 bg-slate-700 rounded-md px-2 py-1"
                value={genTempo} onChange={e=>setGenTempo(clamp(parseInt(e.target.value||"0",10), 60, 140))}/>
              <span>bpm</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-80">小節</span>
              <input type="number" min={4} max={32} step={2}
                className="w-20 bg-slate-700 rounded-md px-2 py-1"
                value={genBars} onChange={e=>setGenBars(clamp(parseInt(e.target.value||"0",10),4,32))}/>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-80">密度</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={genDensity}
                onChange={(e)=>setGenDensity(e.target.value)}>
                <option value="low">少なめ</option>
                <option value="mid">ふつう</option>
                <option value="high">多め</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-80">同時発音</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={genMaxVoices}
                onChange={(e)=>setGenMaxVoices(parseInt(e.target.value,10))}>
                <option value={1}>1 声（右手）</option>
                <option value={2}>2 声（右手に和音）</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="opacity-80">左手</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={leftHand}
                onChange={(e)=>setLeftHand(e.target.value)}>
                <option value="none">なし</option>
                <option value="bass">単音ベース</option>
                <option value="block">ブロック和音</option>
                <option value="alberti">アルベルティ</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="opacity-80">鍵盤範囲</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={rangePreset}
                onChange={(e)=>setRangePreset(e.target.value)}>
                <option value="auto">Auto（楽曲解析）</option>
                <option value="24">24鍵（幼児）</option>
                <option value="48">48鍵（小学生）</option>
                <option value="61">61鍵（標準）</option>
                <option value="88">88鍵（フル）</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="opacity-80">ラベル</span>
              <select className="bg-slate-700 rounded-md px-2 py-1" value={labelMode}
                onChange={(e)=>setLabelMode(e.target.value)}>
                <option value="none">非表示</option>
                <option value="AG">A–G（英名）</option>
                <option value="DoReMi">ドレミ</option>
              </select>
            </div>

            <div className="ml-auto flex items-center gap-4">
              <span className="opacity-80 font-medium">Effect:</span>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="effectLevel" value="focus"
                  checked={effectLevel==='focus'} onChange={(e)=>setEffectLevel(e.target.value)}/>
                🎯 集中
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="effectLevel" value="standard"
                  checked={effectLevel==='standard'} onChange={(e)=>setEffectLevel(e.target.value)}/>
                ✨ 標準
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input type="radio" name="effectLevel" value="fun"
                  checked={effectLevel==='fun'} onChange={(e)=>setEffectLevel(e.target.value)}/>
                🎉 楽しさ
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
              disabled={!notes.length || isPlaying || !instReady} onClick={play}>Play</button>
            <button className="px-3 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50"
              disabled={!isPlaying} onClick={pause}>Pause</button>
            <button className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50"
              disabled={!notes.length} onClick={()=>stop(true)}>Stop</button>
            <div className="ml-auto text-sm opacity-80">
              {fmt(playhead)} / {fmt(Math.max(durationRef.current, isFinite(endTimeRef.current)?endTimeRef.current:0))} <span className="ml-2 text-xs opacity-60">({Math.round(rate*100)}%)</span>
            </div>
          </div>

          <div style={{height: 520, border: '1px solid #334155', borderRadius: 12, overflow: 'hidden'}}>
            <canvas ref={canvasRef} style={{width:"100%", height:"100%", display:"block"}}/>
          </div>

          <p className="text-xs opacity-70">
            🎯集中＝鍵盤発光＋落下ノートのみ／✨標準＝リップルのみ／🎉楽しさ＝光柱＆スパーク＋リップル。<br/>
            Autoで楽曲に最適化された鍵盤表示。キー: 1=20% … 9=90%, 0=100%。
          </p>
        </div>
      </div>

      {/* ライブラリモーダル */}
      {libOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-xl p-4 w-[560px] max-w-[90%]">
            <div className="flex items-center mb-2">
              <div className="font-semibold">ライブラリ</div>
              <button className="ml-auto px-2 py-1 bg-slate-700 rounded" onClick={()=>setLibOpen(false)}>✕</button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-auto">
              {libItems.length===0 && <div className="opacity-70 text-sm">保存された曲はありません。</div>}
              {libItems.map(item=>(
                <div key={item.id} className="flex items-center gap-2 bg-slate-700/60 rounded px-3 py-2">
                  <div className="flex-1">
                    <div className="font-medium">{item.name || "(無題)"}</div>
                    <div className="text-xs opacity-70">
                      {fmtDate(item.createdAt)}・{(item.size/1024).toFixed(1)} KB
                      {item.settings && (
                        <span className="ml-2 opacity-80">
                          [{item.settings.key}/{item.settings.tempo}bpm/{item.settings.bars}bars/{item.settings.density}/{item.settings.maxVoices}v/LH:{item.settings.leftHand||"none"}]
                        </span>
                      )}
                    </div>
                  </div>
                  <button className="px-2 py-1 bg-indigo-600 rounded hover:bg-indigo-500" onClick={()=>loadFromLibrary(item.id)}>読込</button>
                  <button className="px-2 py-1 bg-rose-700 rounded hover:bg-rose-600" onClick={()=>removeFromLibrary(item.id)}>削除</button>
                </div>
              ))}
            </div>
            <div className="mt-3 text-right">
              <button className="px-3 py-2 bg-slate-700 rounded" onClick={()=>setLibOpen(false)}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
