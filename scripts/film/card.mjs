// Render one branded card to PNG.
//
// Values are injected into the live document rather than passed on the URL: a
// file:// query string never reached the page, and the card has to load from the
// app's own origin anyway so its webfonts resolve.
import { execFileSync } from "node:child_process";

import { PW } from "./paths.mjs";

const pw = (...args) => execFileSync(PW, ["-s=cards", ...args], { encoding: "utf8", stdio: "pipe" });

/**
 * @param uiPort  the lane's static host — the card must load from the app's own
 *                origin, so this follows whichever lane is currently recording
 *                instead of assuming a fixed port.
 * @param total   how many pips the progress rule draws; grows with the series.
 */
export function renderCard({
  out,
  eyebrow,
  title,
  sub,
  n,
  total = 10,
  uiPort = 5300,
  badge = "Recorded live",
  note = "The work moves. You hold the helm.",
}) {
  pw("open", `http://127.0.0.1:${uiPort}/titlecard.html`);
  pw("resize", "1280", "800");
  // The page cannot read a local file, so paint the values directly.
  const payload = JSON.stringify({ eyebrow, title, sub, n, total, badge, note });
  const out_ = pw("eval", `() => {
    const c = ${payload};
    const el = document.getElementById("title");
    if (!el) return "NOT-A-CARD";
    const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.innerHTML = v; };
    set("eyebrow", c.eyebrow); set("title", c.title); set("sub", c.sub);
    set("badge", c.badge); set("foot-note", c.note);
    const rule = document.getElementById("rule");
    if (rule) rule.innerHTML =
      Array.from({ length: c.total }, (_, i) => '<i class="' + (i < c.n ? "on" : "") + '"></i>').join("");
    return "CARD:" + el.textContent;
  }`);

  // The static host answers unknown paths with the SPA entry, so a missing
  // dist/titlecard.html silently screenshots the ONBOARDING SCREEN instead of a
  // card — footage that looks plausible in a thumbnail and is worthless. Read
  // only the printed result block (the CLI also echoes the script source, which
  // contains every literal above and would match any naive substring check).
  const marker = out_.indexOf("### Result");
  const body = marker === -1 ? "" : out_.slice(marker + 10).split("### Ran")[0].trim();
  if (!body.includes("CARD:")) {
    throw new Error(
      `title card did not render at http://127.0.0.1:${uiPort}/titlecard.html — ` +
      `copy scripts/film/titlecard.html into the served dist/ first. Got: ${body.slice(0, 120)}`,
    );
  }

  pw("screenshot", "--filename", out);
  return out;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [out, eyebrow, title, sub, n, badge] = process.argv.slice(2);
  renderCard({ out, eyebrow, title, sub, n: Number(n), badge });
  console.log("rendered", out);
}
