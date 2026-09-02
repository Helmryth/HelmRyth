#!/usr/bin/env node
// Measures the palette in src/styles.css against WCAG 2.1 AA.
//
//   node scripts/check-contrast.mjs        (or: pnpm check:contrast)
//
// It parses the stylesheet instead of keeping a second copy of the values, so
// the check can never pass against a palette that is no longer the shipped
// one. Two things it does that a quick eyeball does not:
//
//   - composites alpha. --color-ink-secondary is #fcfcfc99, and measuring it
//     as opaque #fcfcfc overstates every secondary-text pair in the app.
//   - measures white on filled surfaces, which is what the components
//     actually render (`bg-accent … text-white`), not the token against the
//     page ground.
//
// The three pairs already below AA are listed in KNOWN below with the ratio
// they measure today, so adopting this check does not force a palette change
// in the same commit. Anything new fails the run — and so does a known pair
// that gets WORSE than its recorded floor.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

/** Custom properties from @theme and :root, in cascade order.
 *
 * Comments are stripped first: a declaration left behind in a comment reads
 * exactly like a live one, so a token that was removed but still mentioned
 * would be measured at its stale value instead of reported as undefined. */
function parseTokens(source) {
  const tokens = {};
  const live = source.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, body] of live.matchAll(/(?:@theme|:root)[^{]*\{([^}]*)\}/g)) {
    for (const [, name, value] of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
  }
  return tokens;
}

function cssNumber(value, percentScale = 1) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "none") return null;
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return null;
  return trimmed.endsWith("%") ? number / 100 * percentScale : number;
}

function hueDegrees(value) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "none") return 0;
  const number = Number.parseFloat(trimmed);
  if (!Number.isFinite(number)) return null;
  if (trimmed.endsWith("turn")) return number * 360;
  if (trimmed.endsWith("grad")) return number * 0.9;
  if (trimmed.endsWith("rad")) return number * 180 / Math.PI;
  return number;
}

/**
 * CSS Color 4 OKLCH to encoded sRGB. The matrix is the published OKLab
 * inverse transform; linear channels are then encoded with the sRGB transfer
 * curve. Clamping models an sRGB display for WCAG's relative-luminance math.
 */
function parseOklch(value) {
  const match = value.trim().match(
    /^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)(?:\s*\/\s*([^\s)]+))?\s*\)$/i,
  );
  if (!match) return null;
  const lightness = cssNumber(match[1], 1);
  // CSS defines 100% OKLCH chroma as 0.4.
  const chroma = cssNumber(match[2], 0.4);
  const hue = hueDegrees(match[3]);
  const alpha = match[4] === undefined ? 1 : cssNumber(match[4], 1);
  if (lightness === null || chroma === null || hue === null || alpha === null) return null;
  if (lightness < 0 || lightness > 1 || chroma < 0 || alpha < 0 || alpha > 1) return null;

  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);

  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.2914855480 * b;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;

  const linear = {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  };
  const encode = (channel) => {
    const clipped = Math.min(1, Math.max(0, channel));
    return clipped <= 0.0031308
      ? 12.92 * clipped
      : 1.055 * clipped ** (1 / 2.4) - 0.055;
  };
  return { r: encode(linear.r), g: encode(linear.g), b: encode(linear.b), a: alpha };
}

/** #rgb, #rrggbb, #rrggbbaa, or CSS OKLCH → encoded sRGB in 0..1. */
function parseColor(value) {
  const oklch = parseOklch(value);
  if (oklch) return oklch;
  const h = value.replace("#", "").trim();
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) return null;
  const n = (i) => parseInt(full.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
}

/** Lay a possibly-translucent colour over an opaque one. */
function composite(fg, bg) {
  if (fg.a === 1) return fg;
  const mix = (f, b) => f * fg.a + b * (1 - fg.a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

function luminance({ r, g, b }) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fgValue, bgValue) {
  const bg = parseColor(bgValue);
  const fg = parseColor(fgValue);
  if (!fg || !bg) return null;
  if (bg.a !== 1) return null; // a translucent ground has no single answer
  const [hi, lo] = [luminance(composite(fg, bg)), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = [
  "--color-app",
  "--color-panel",
  "--color-raised",
  "--color-card",
  "--color-inset",
];

// AA asks 4.5:1 of body text and 3:1 of non-text indicators (1.4.11).
const PAIRS = [
  // body and secondary text on every ground a panel can sit on
  ...SURFACES.map((s) => ["--color-ink", s, 4.5, "body text"]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5, "secondary text (60% alpha)"]),
  ["--color-ink", "--color-bubble-user", 4.5, "your own messages"],
  // what the filled buttons actually render: white on a solid accent/danger
  ["#ffffff", "--color-accent", 4.5, "primary buttons — bg-accent + text-white"],
  ["#ffffff", "--color-danger", 4.5, "destructive buttons — bg-danger + text-white"],
  // coloured text on a ground
  ["--color-accent", "--color-app", 4.5, "accent as text/links"],
  ["--color-accent", "--color-card", 4.5, "accent as text on a card"],
  ["--color-danger", "--color-card", 4.5, "error text"],
  ["--color-success", "--color-card", 4.5, "success text"],
  ["--color-warning", "--color-card", 4.5, "warning text"],
  // indicators: outline, not glyphs
  ["--color-focus", "--color-app", 3, "focus ring"],
  ["--color-focus", "--color-panel", 3, "focus ring on a panel"],
  ["--color-accent-border", "--color-card", 3, "accent border"],
];

// A temporary exception must record the measured ratio as a floor. The
// current Helmryth palette carries no exceptions: every listed pair must meet
// its WCAG threshold.
const KNOWN = new Map();

// Rounding headroom: the floors above are quoted to two decimals, so a value
// that is unchanged can measure a hair under its own printed figure.
const DRIFT = 0.01;

const tokens = parseTokens(css);
const resolve = (name) => (name.startsWith("--") ? tokens[name] : name);

let failed = false;
const carried = [];
let measured = 0;

for (const [fg, bg, min, where] of PAIRS) {
  const fgValue = resolve(fg);
  const bgValue = resolve(bg);
  if (!fgValue || !bgValue) {
    // An unmeasurable pair is reported, never skipped: silently passing over
    // a renamed token is how a check quietly stops checking.
    console.log(`✗ undefined token in pair: ${fg} on ${bg}`);
    failed = true;
    continue;
  }
  const ratio = contrast(fgValue, bgValue);
  if (ratio === null) {
    console.log(`✗ cannot measure ${fg} on ${bg} (${fgValue} on ${bgValue})`);
    failed = true;
    continue;
  }
  measured++;
  if (ratio >= min) continue;

  const key = `${fg} on ${bg}`;
  const line = `${key}: ${ratio.toFixed(2)}:1 (needs ${min}:1) — ${where}`;
  const floor = KNOWN.get(key);
  if (floor === undefined) {
    console.log(`✗ ${line}`);
    failed = true;
  } else if (ratio < floor - DRIFT) {
    console.log(`✗ ${line} — WORSE than the recorded ${floor.toFixed(2)}:1`);
    failed = true;
  } else {
    carried.push(line);
  }
}

// A known pair that now clears AA never reaches the block above, so say it
// here — otherwise the entry sits in KNOWN forever, shielding a pair that no
// longer needs shielding.
for (const [key, floor] of KNOWN) {
  const [fg, bg] = key.split(" on ");
  const fgValue = resolve(fg);
  const bgValue = resolve(bg);
  if (!fgValue || !bgValue) continue;
  const ratio = contrast(fgValue, bgValue);
  if (ratio !== null && ratio >= 4.5) {
    console.log(`✓ ${key} now measures ${ratio.toFixed(2)}:1 — remove it from KNOWN (floor was ${floor.toFixed(2)})`);
  }
}

if (carried.length) {
  console.log("Known, carried (listed in KNOWN):");
  for (const line of carried) console.log(`  ~ ${line}`);
}
console.log(
  failed
    ? `\n${measured} pairs measured — new contrast failures above.`
    : `\n✓ ${measured} pairs measured, no new failures.`,
);
process.exit(failed ? 1 : 0);
