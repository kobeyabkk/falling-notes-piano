import React, { useEffect, useMemo, useRef } from "react";
import getNoteLabel from "./flowNames";

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

function nowSec() {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

function createLaneStates(count) {
  return Array.from({ length: count }, () => ({
    nextAvailableTime: -Infinity,
  }));
}

const LANE_SPACING_RATIO = 0.6;
const BACKDROP_ALPHA = 0.55;

const CommentOverlay = React.memo(function CommentOverlay({
  events = [],
  currentSec = 0,
  playing = false,
  rate = 1,
  settings = {},
}) {
  const canvasRef = useRef(null);
  const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
  const laneStateRef = useRef(createLaneStates(1));
  const eventStateRef = useRef(new Map());
  const measureCacheRef = useRef(new Map());
  const syncBaseRef = useRef({ sec: currentSec, perf: nowSec() });

  const {
    locale = "jp",
    showOctave = false,
    fontSize: rawFontSize = 28,
    lanes: rawLanes = 2,
    travelSec: rawTravelSec = 8,
    preferSharps = true,
  } = settings || {};

  const lanes = clamp(Math.round(rawLanes || 1), 1, 4);
  const fontSize = clamp(rawFontSize || 24, 16, 48);
  const travelSec = clamp(rawTravelSec || 8, 4, 10);

  const overlayHeight = useMemo(() => {
    const verticalPadding = Math.max(8, fontSize * 0.35);
    const laneHeight = fontSize * 1.4;
    return Math.ceil(verticalPadding * 2 + laneHeight * lanes);
  }, [fontSize, lanes]);

  const processedEvents = useMemo(() => {
    if (!events?.length) return [];
    return events
      .map((ev, idx) => ({
        id: `${idx}-${ev.startSec}-${ev.midi}`,
        startSec: typeof ev.startSec === "number" ? ev.startSec : 0,
        midi: ev.midi,
      }))
      .sort((a, b) => a.startSec - b.startSec);
  }, [events]);

  useEffect(() => {
    syncBaseRef.current = { sec: currentSec, perf: nowSec() };
  }, [currentSec]);

  useEffect(() => {
    syncBaseRef.current = { sec: currentSec, perf: nowSec() };
  }, [playing, rate]);

  useEffect(() => {
    eventStateRef.current = new Map();
    laneStateRef.current = createLaneStates(lanes);
    measureCacheRef.current = new Map();
  }, [processedEvents, lanes, fontSize, locale, showOctave, preferSharps, travelSec]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const parent = canvas.parentElement;
      const rect = parent ? parent.getBoundingClientRect() : canvas.getBoundingClientRect();
      const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

      if (
        rect.width !== sizeRef.current.width ||
        rect.height !== sizeRef.current.height ||
        dpr !== sizeRef.current.dpr
      ) {
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        sizeRef.current = { width: rect.width, height: rect.height, dpr };
        eventStateRef.current = new Map();
        laneStateRef.current = createLaneStates(lanes);
        measureCacheRef.current = new Map();
      }

      const width = rect.width;
      const height = rect.height;
      ctx.clearRect(0, 0, width, height);

      if (!processedEvents.length || width <= 0 || height <= 0) {
        return;
      }

      const bgGradient = ctx.createLinearGradient(0, 0, 0, height);
      bgGradient.addColorStop(0, `rgba(15,23,42,${BACKDROP_ALPHA})`);
      bgGradient.addColorStop(1, `rgba(15,23,42,${BACKDROP_ALPHA * 0.5})`);
      ctx.fillStyle = bgGradient;
      ctx.fillRect(0, 0, width, height);

      const base = syncBaseRef.current;
      let effectiveSec = base.sec;
      if (playing) {
        const now = nowSec();
        const delta = Math.max(0, now - base.perf);
        effectiveSec = base.sec + delta * Math.max(rate, 0);
      }

      const laneHeight = fontSize * 1.4;
      const verticalPadding = Math.max(8, fontSize * 0.35);
      const textBaselineY = (lane) => verticalPadding + laneHeight * lane + laneHeight / 2;
      const textColor = "rgba(248,250,252,0.95)";
      const shadowColor = "rgba(15,23,42,0.9)";
      ctx.textBaseline = "middle";
      ctx.fillStyle = textColor;
      ctx.shadowColor = shadowColor;
      ctx.shadowBlur = 8;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.font = `600 ${fontSize}px 'Noto Sans JP', 'Hiragino Sans', 'Noto Sans', system-ui, sans-serif`;

      const cache = measureCacheRef.current;
      const eventStates = eventStateRef.current;
      const laneStates = laneStateRef.current;
      const safeTravel = Math.max(0.1, travelSec);
      const laneSpacingPx = fontSize * LANE_SPACING_RATIO;

      for (const lane of laneStates) {
        if (!lane) continue;
        if (!Number.isFinite(lane.nextAvailableTime)) lane.nextAvailableTime = -Infinity;
      }

      const visibleWindowStart = effectiveSec - safeTravel * 1.2;
      const visibleWindowEnd = effectiveSec + safeTravel * 1.2;

      for (const ev of processedEvents) {
        if (ev.startSec > visibleWindowEnd) break;
        if (ev.startSec + safeTravel < visibleWindowStart) continue;

        const label = getNoteLabel(ev.midi, { locale, showOctave, preferSharps });
        if (!label) continue;

        const cacheKey = `${fontSize}:${label}`;
        let textWidth = cache.get(cacheKey);
        if (textWidth == null) {
          textWidth = ctx.measureText(label).width;
          cache.set(cacheKey, textWidth);
        }

        let state = eventStates.get(ev.id);
        if (!state) {
          let assigned = 0;
          let bestLane = 0;
          let earliest = Infinity;
          for (let i = 0; i < lanes; i += 1) {
            const lane = laneStates[i];
            if (!lane) continue;
            if (ev.startSec >= lane.nextAvailableTime - 1e-3) {
              assigned = i;
              earliest = -Infinity;
              break;
            }
            if (lane.nextAvailableTime < earliest) {
              earliest = lane.nextAvailableTime;
              bestLane = i;
            }
          }
          if (earliest !== -Infinity) assigned = bestLane;
          state = { lane: assigned, width: textWidth };
          eventStates.set(ev.id, state);

          const lane = laneStates[assigned];
          if (lane) {
            const totalDistance = width + textWidth;
            const spacing = textWidth + laneSpacingPx;
            const safeDuration = safeTravel * (spacing / Math.max(1, totalDistance));
            lane.nextAvailableTime = ev.startSec + safeDuration;
          }
        } else {
          state.width = textWidth;
        }

        const laneIndex = state.lane ?? 0;
        const totalDistance = width + state.width;
        const progress = (effectiveSec - ev.startSec) / safeTravel;
        const x = width - progress * totalDistance;

        if (x < -state.width) {
          eventStates.delete(ev.id);
          continue;
        }
        if (x > width + state.width) {
          continue;
        }

        const y = textBaselineY(clamp(laneIndex, 0, lanes - 1));

        const hue = ((ev.midi % 12) / 12) * 360;
        ctx.fillStyle = `hsla(${hue.toFixed(1)}, 70%, 65%, 0.95)`;
        ctx.fillText(label, x, y);
      }

      ctx.shadowColor = "transparent";
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [processedEvents, playing, rate, fontSize, lanes, travelSec, locale, showOctave, preferSharps, overlayHeight]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-x-0 top-0 z-10"
      style={{ width: "100%", height: `${overlayHeight}px`, display: "block" }}
    />
  );
});

export default CommentOverlay;
