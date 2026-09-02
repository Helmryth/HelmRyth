// Release the browsers and lanes of films that are already recorded.
//
// Every playwright-cli session keeps a daemon plus a full Chrome process tree
// alive until something closes it, and a probe session left open costs as much
// as a real take. Across a batch that silently reaches double-digit gigabytes,
// and the visible symptom is not "out of memory" — it is later takes recording
// spinners, which reads as a product bug.
//
//   node scripts/film/sweep.mjs            # report only
//   node scripts/film/sweep.mjs --apply    # actually close them
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";

import { RAW, LANES, PW } from "./paths.mjs";

const apply = process.argv.includes("--apply");
const sh = (cmd) => { try { return execFileSync("bash", ["-lc", cmd], { encoding: "utf8" }); } catch (e) { return String(e.stdout ?? ""); } };

const recorded = new Set(
  (existsSync(RAW) ? readdirSync(RAW) : [])
    .filter((f) => f.endsWith(".webm"))
    .map((f) => f.replace(/\.webm$/, "")),
);

// A session belongs to a finished film when its name starts with that film's
// id. Scratch names (probe/dry/explore/smoke/par/cards) are always disposable —
// they exist only to answer a question that has already been answered.
const SCRATCH = /(probe|dry|explore|smoke|par-|cards|check)/i;
const isDone = (session) =>
  SCRATCH.test(session) || [...recorded].some((id) => session.startsWith(id));

const sessions = sh(`ps -eo pid,args | grep cliDaemon.js | grep -v grep`)
  .split("\n").filter(Boolean)
  .map((line) => {
    const pid = line.trim().split(/\s+/)[0];
    const session = line.match(/cliDaemon\.js\s+(\S+)/)?.[1] ?? "";
    return { pid, session };
  })
  .filter((s) => s.session);

let closed = 0;
for (const { pid, session } of sessions) {
  if (!isDone(session)) { console.log(`  keep    ${session}`); continue; }
  if (apply) {
    // Ask the CLI to close first so it can tear its own browser down cleanly;
    // fall back to the daemon pid only if that does not take.
    sh(`${PW} -s=${session} close 2>/dev/null`);
    sh(`kill -9 ${pid} 2>/dev/null`);
  }
  console.log(`  ${apply ? "closed " : "would  "} ${session}`);
  closed += 1;
}

let lanes = 0;
for (const lane of existsSync(LANES) ? readdirSync(LANES) : []) {
  if (!recorded.has(lane) && !SCRATCH.test(lane)) { continue; }
  if (apply) sh(`kill -9 $(cat ${LANES}/${lane}/core.pid 2>/dev/null) $(cat ${LANES}/${lane}/static.pid 2>/dev/null) 2>/dev/null`);
  lanes += 1;
}

const rss = sh(`ps -eo rss | awk 'NR>1{r+=$1} END{printf "%.1f", r/1048576}'`).trim();
console.log(`\n${apply ? "closed" : "would close"} ${closed} session(s), ${lanes} lane(s) — total RSS now ${rss} GB`);
