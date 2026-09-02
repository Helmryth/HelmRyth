// Cut every raw take into a finished film: branded opening card, the live
// footage, a closing card, plus a poster frame.
//
//   node scripts/film/cut.mjs            # cut everything in the cut list
//   node scripts/film/cut.mjs 11-runs    # cut one
//
// A lane must be up so the card page is served from the app's own origin —
// its webfonts will not resolve from file://, and the static host answers
// unknown paths with the SPA entry, so a missing dist/titlecard.html silently
// screenshots the onboarding screen instead. renderCard() hard-fails on that.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

import { RAW, FRAMES, FINAL, REPO } from "./paths.mjs";
import { renderCard } from "./card.mjs";
import { buildFilm } from "./post.mjs";

const UI_PORT = Number(process.env.HELMRYTH_CARD_UI_PORT ?? 5900);
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));

const cutList = JSON.parse(readFileSync(`${REPO}/output/film/plan/cut-list.json`, "utf8"));
const films = only.length ? cutList.filter((f) => only.includes(f.id)) : cutList;
const total = cutList.length;

mkdirSync(FRAMES, { recursive: true });
mkdirSync(FINAL, { recursive: true });

// One closing card for the whole series.
const endCard = `${FRAMES}/end-card.png`;
renderCard({
  out: endCard, n: total, total, uiPort: UI_PORT,
  eyebrow: "Helmryth",
  title: "The work moves. <em>You hold the helm.</em>",
  sub: "Local-first. Your operators, your machine, your gates.",
  badge: "Recorded live, in one take",
});

const probe = (file) => Number(execFileSync("ffprobe",
  ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

const built = [];
for (const film of films) {
  const raw = `${RAW}/${film.id}.webm`;
  if (!existsSync(raw)) { console.log(`  skip ${film.id} (no footage)`); continue; }

  const card = `${FRAMES}/card-${film.id}.png`;
  renderCard({
    out: card, uiPort: UI_PORT,
    n: cutList.findIndex((f) => f.id === film.id) + 1, total,
    eyebrow: `Feature ${String(film.n).padStart(2, "0")}`,
    title: film.title, sub: film.sub,
  });

  // Keep every film inside the 45-90s band: tighten only what runs long. The
  // flows are script-driven, so the only genuinely slow parts are real waits —
  // a model thinking, a container starting.
  const rawSecs = probe(raw);
  const target = 78;
  const speed = rawSecs > target ? Math.min(1.45, rawSecs / target) : 1;

  const r = buildFilm({ raw, card, endCard, out: `${FINAL}/${film.id}.mp4`, speed });
  built.push({ id: film.id, seconds: r.seconds, speed });
  console.log(`  ${film.id.padEnd(24)} ${r.seconds.toFixed(1)}s  (raw ${rawSecs.toFixed(0)}s @ ${speed.toFixed(2)}x)`);
}

const runtime = built.reduce((n, b) => n + b.seconds, 0);
console.log(`\n${built.length} films cut · ${(runtime / 60).toFixed(1)} min total`);
