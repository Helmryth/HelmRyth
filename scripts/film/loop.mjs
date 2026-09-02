// Cut a README loop and a poster frame out of a finished film.
//
//   node scripts/film/loop.mjs <id> <startSeconds> [--from <dir>] [--to <dir>]
//   node scripts/film/loop.mjs --manifest loops.json
//
// A loop is the twelve seconds where a feature actually happens, so the start
// time is a judgement call about the footage and never a default — pass it in.
//
// The output is an animated GIF written under a `.png` name. That is deliberate,
// not a mistake: GitHub renders a repo-relative `<video>` as nothing and puts a
// click-to-play control in front of anything it recognises as a `.gif`, so a
// README full of honest `.gif` loops sits there motionless until a reader clicks
// each one. Browsers dispatch on the magic bytes rather than the extension, so
// the same bytes under a `.png` name animate on load. Nothing is re-encoded to
// achieve this and the file is a valid GIF89a either way.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";

import { FINAL, REPO } from "./paths.mjs";

const WIDTH = 860; // 1280x800 film scaled to the README's column, height derived
const FPS = 10;
const SECONDS = 12;

const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

const probe = (file, entries) =>
  execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "csv=p=0", file], {
    encoding: "utf8",
  }).trim();

/**
 * Build `<id>-loop.png` (animated) and `<id>.png` (poster) from `<id>.mp4`.
 * Two ffmpeg passes: the first derives a palette from the exact frames the loop
 * will contain, the second maps onto it. A single-pass GIF picks the web-safe
 * palette instead and bands every warm surface in the product's own canvas.
 */
export function buildLoop({ id, start, from = FINAL, to = `${REPO}/docs/media`, colors = 256 }) {
  const film = `${from}/${id}.mp4`;
  if (!existsSync(film)) throw new Error(`no film at ${film}`);

  const duration = Number(probe(film, "format=duration"));
  if (!Number.isFinite(duration)) throw new Error(`could not read duration of ${film}`);
  if (start + SECONDS > duration) {
    throw new Error(
      `${id}: window ${start}s+${SECONDS}s runs past the end of a ${duration.toFixed(1)}s film`,
    );
  }

  mkdirSync(to, { recursive: true });
  const palette = `/tmp/hry-palette-${id}.png`;
  const loop = `${to}/${id}-loop.png`;
  const poster = `${to}/${id}.png`;

  const filters = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
  // stats_mode=diff spends the palette on what MOVES between frames rather than
  // on the large static chrome, which is most of a screen recording.
  // Fewer colours is the one lever that meaningfully shrinks these. The product
  // is flat warm surfaces and text, so a film that scrolls a lot blows past 3MB
  // at the full 256 and loses almost nothing at 128 — and every loop on the page
  // downloads at once, so the page weight is the sum of all of them.
  ff("-ss", String(start), "-t", String(SECONDS), "-i", film,
    "-vf", `${filters},palettegen=stats_mode=diff:max_colors=${colors}`, palette);
  ff("-ss", String(start), "-t", String(SECONDS), "-i", film, "-i", palette,
    "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", "-f", "gif", loop);
  unlinkSync(palette);

  // The poster is the frame a reader sees before the loop paints, and it is what
  // the linked film opens on, so take it from inside the loop's own window.
  ff("-ss", String(start + SECONDS / 2), "-i", film, "-vframes", "1", poster);

  return {
    id,
    loopKb: Math.round(statSync(loop).size / 1024),
    posterKb: Math.round(statSync(poster).size / 1024),
    dimensions: probe(loop, "stream=width,height").replace(",", "x"),
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };

  const manifest = flag("--manifest");
  const jobs = manifest
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : [{ id: args[0], start: Number(args[1]) }];
  const colors = flag("--colors") ? Number(flag("--colors")) : undefined;

  const opts = { from: flag("--from") ?? FINAL, to: flag("--to") ?? `${REPO}/docs/media` };
  if (colors) opts.colors = colors;
  let totalKb = 0;
  for (const job of jobs) {
    try {
      const r = buildLoop({ ...job, ...opts });
      totalKb += r.loopKb + r.posterKb;
      console.log(`  ${r.id.padEnd(26)} ${r.dimensions}  loop ${String(r.loopKb).padStart(5)}KB  poster ${String(r.posterKb).padStart(4)}KB`);
    } catch (error) {
      console.log(`  ${String(job.id).padEnd(26)} FAILED — ${error.message}`);
    }
  }
  console.log(`\n${jobs.length} loops · ${(totalKb / 1024).toFixed(1)}MB added`);
}
