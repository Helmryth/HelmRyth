// Weld a branded title card, the live screen recording, and an end card into one
// README-embeddable MP4 (plus a poster frame).
//
// Everything is normalised to 1280x800 @30fps first: the browser writes VP8 at a
// variable frame rate, and concatenating that with still images without a common
// timebase produces a file whose duration lies to every player.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ff = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { stdio: "pipe" });
const probe = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());

/**
 * @param cardSecs   how long the opening card holds before the footage starts
 * @param endSecs    how long the closing card holds
 * @param speed      >1 tightens dead air; the flows are driven by a script, so
 *                   real pauses (a model thinking) are the only slow parts
 */
export function buildFilm({ raw, card, endCard, out, cardSecs = 3.2, endSecs = 2.4, speed = 1 }) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = "/tmp/helmryth-film";
  mkdirSync(tmp, { recursive: true });

  const norm = `${tmp}/norm.mp4`;
  const filters = [
    `fps=30`,
    `scale=1280:800:force_original_aspect_ratio=decrease`,
    `pad=1280:800:(ow-iw)/2:(oh-ih)/2:color=0xF9F5EF`,
    // `pad` leaves the sample aspect ratio undefined (0:1) when the source was
    // not already 1280x800, and the concat filter below then refuses the clip
    // outright — "parameters do not match" — even though every visible
    // dimension agrees. A take recorded at any other window size dies here
    // without this, which is exactly what a re-shoot is most likely to be.
    `setsar=1`,
    speed !== 1 ? `setpts=${(1 / speed).toFixed(4)}*PTS` : null,
  ].filter(Boolean).join(",");
  ff("-i", raw, "-vf", filters, "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "22", "-pix_fmt", "yuv420p", norm);

  const openClip = `${tmp}/open.mp4`;
  ff("-loop", "1", "-i", card, "-t", String(cardSecs), "-vf", "fps=30,scale=1280:800,format=yuv420p",
     "-c:v", "libx264", "-preset", "medium", "-crf", "22", openClip);

  const parts = [openClip, norm];
  if (endCard && existsSync(endCard)) {
    const endClip = `${tmp}/end.mp4`;
    ff("-loop", "1", "-i", endCard, "-t", String(endSecs), "-vf", "fps=30,scale=1280:800,format=yuv420p",
       "-c:v", "libx264", "-preset", "medium", "-crf", "22", endClip);
    parts.push(endClip);
  }

  // Concat filter rather than the demuxer: the demuxer needs identical codec
  // parameters and silently produces a broken timeline when they drift.
  const inputs = parts.flatMap((p) => ["-i", p]);
  const graph = `${parts.map((_, i) => `[${i}:v]`).join("")}concat=n=${parts.length}:v=1:a=0[v]`;
  ff(...inputs, "-filter_complex", graph, "-map", "[v]",
     "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-pix_fmt", "yuv420p",
     "-movflags", "+faststart", out);

  const poster = out.replace(/\.mp4$/, ".png");
  ff("-i", out, "-ss", String(cardSecs + 1.5), "-vframes", "1", poster);

  return { out, poster, seconds: probe(out) };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [raw, card, endCard, out, speed] = process.argv.slice(2);
  const r = buildFilm({ raw, card, endCard: endCard === "-" ? null : endCard, out, speed: Number(speed || 1) });
  console.log(`${r.out}  ${r.seconds.toFixed(1)}s`);
}
