// Stage a recording lane: bring up an isolated stack, seed believable state
// off-camera, open the app, and start the recorder.
//
// Seeding happens through the API rather than the UI so the footage is all
// product and no setup chores. What the camera sees is the real renderer
// talking to a real core — nothing is stubbed.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import { FILM, LANES, RAW, PW } from "./paths.mjs";
import { makeDriver, passOnboarding, IDENTITY } from "./drive.mjs";

export const sh = (cmd) => {
  try {
    return execFileSync("bash", ["-lc", cmd], { encoding: "utf8" });
  } catch (error) {
    return String(error.stdout ?? "");
  }
};

/** One lane's coordinates. Ports step by 10 so each core's webhook port (+1) is free. */
export function lane(name, corePort, uiPort) {
  return {
    name,
    corePort,
    uiPort,
    core: `http://127.0.0.1:${corePort}`,
    ui: `http://127.0.0.1:${uiPort}`,
    dir: `${LANES}/${name}`,
  };
}

/** Call the local core directly. The renderer Origin is required by the core's boundary. */
export function api(L, method, path, body) {
  const args = ["-s", "-X", method, `${L.core}${path}`, "-H", `Origin: ${L.ui}`, "-H", "Content-Type: application/json"];
  if (body !== undefined) args.push("--data", JSON.stringify(body));
  try {
    return JSON.parse(execFileSync("curl", args, { encoding: "utf8" }) || "{}");
  } catch {
    return {};
  }
}

/** Restart a lane, optionally discarding its data directory first. */
export function resetLane(L, { fresh = true } = {}) {
  sh(`kill $(cat ${L.dir}/core.pid 2>/dev/null) $(cat ${L.dir}/static.pid 2>/dev/null) 2>/dev/null; sleep 1`);
  if (fresh) sh(`rm -rf ${L.dir}/profile && mkdir -p ${L.dir}/profile`);
  mkdirSync(RAW, { recursive: true });
  const out = sh(`bash ${FILM}/stack.sh ${L.name} ${L.corePort} ${L.uiPort} 2>&1`);
  if (!out.includes("READY")) throw new Error(`lane ${L.name} did not come up:\n${out}`);
  // The title card is served from the app's own origin so its webfonts resolve.
  sh(`cp ${FILM}/titlecard.html ${process.env.HELMRYTH_STATIC_ROOT ?? `${FILM}/../../dist`}/titlecard.html`);
  return out;
}

/** Give the workspace a believable roster before the camera rolls. */
export function seedOperators(L, specs) {
  const made = [];
  for (const s of specs) {
    const created = api(L, "POST", "/api/bots", { name: s.name });
    const bot = created.bot;
    if (!bot) continue;
    api(L, "PATCH", `/api/bots/${bot.id}`, { title: s.title, description: s.description, color: s.color });
    made.push({ ...bot, ...s });
  }
  return made;
}

export function openApp(L, session, { onboarded = true } = {}) {
  const d = makeDriver(session);
  d.pw("open", "--headed", L.ui);
  d.sleep(4000);
  d.pw("resize", "1280", "800");
  d.sleep(1000);
  if (onboarded && !passOnboarding(d)) throw new Error("setup gate still open — refusing to record over it");
  d.sleep(1200);
  return d;
}

export function startFilm(d, file) {
  // Cursor only — no action badges. The overlay narrated the HARNESS
  // ("Press ControlOrMeta+a", "Press Backspace"), which is scripting exhaust a
  // real user never sees; it made product footage read as test automation.
  // Chapter cards carry the narration instead, and they are editorial.
  d.pw("video-hide-actions");
  d.pw("video-show-actions", "--duration", "1", "--position", "bottom-right", "--cursor", "pointer");
  d.pw("video-start", `${RAW}/${file}`, "--size", "1280x800");
}

export function endFilm(d) {
  d.pw("video-stop");
  // The recorder flushes asynchronously; closing the browser before it lands
  // truncates the file.
  d.sleep(2500);
  // Then release the browser. Each session keeps a cliDaemon plus a full Chrome
  // process tree alive indefinitely, so a batch of takes silently accumulates
  // gigabytes and later shoots start competing with the corpses of earlier
  // ones — which shows up as spinner footage, not as an obvious leak.
  d.pw("close");
}

/** Stop a lane's core and static host. Call this when a film is finished. */
export function stopLane(L) {
  sh(`kill $(cat ${L.dir}/core.pid 2>/dev/null) $(cat ${L.dir}/static.pid 2>/dev/null) 2>/dev/null`);
}

export { PW, IDENTITY };
