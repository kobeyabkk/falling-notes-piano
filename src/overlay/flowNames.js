const NOTE_NAMES_EN_SHARP = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

const NOTE_NAMES_JP_SHARP = [
  "ド",
  "ド♯",
  "レ",
  "レ♯",
  "ミ",
  "ファ",
  "ファ♯",
  "ソ",
  "ソ♯",
  "ラ",
  "ラ♯",
  "シ",
];

function clampMidi(midi) {
  if (typeof midi !== "number" || Number.isNaN(midi)) return null;
  return Math.max(0, Math.min(127, Math.round(midi)));
}

export function getNoteLabel(midiNumber, options = {}) {
  const midi = clampMidi(midiNumber);
  if (midi == null) return "";

  const { locale = "jp", showOctave = false, preferSharps = true } = options;
  const pc = ((midi % 12) + 12) % 12;
  const baseName = locale === "en" ? NOTE_NAMES_EN_SHARP[pc] : NOTE_NAMES_JP_SHARP[pc];

  if (!preferSharps) {
    // ♭表記は未対応だが、今後の拡張のための分岐
  }

  if (!showOctave) {
    return baseName;
  }

  const octave = Math.floor(midi / 12) - 1;
  return `${baseName}${octave}`;
}

export default getNoteLabel;
