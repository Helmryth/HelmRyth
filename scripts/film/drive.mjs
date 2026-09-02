// Driver helpers for the README feature films.
//
// Clicks go through the CLI's own `click` verb rather than page.eval, because
// only real CLI actions get the annotation callout and the animated pointer that
// make these films readable. That means resolving an accessible name to a ref
// from a fresh snapshot before every click.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { PW } from "./paths.mjs";

export function makeDriver(session) {
  const pw = (...args) => {
    try {
      return execFileSync(PW, [`-s=${session}`, ...args], { encoding: "utf8", stdio: "pipe", maxBuffer: 32 * 1024 * 1024 });
    } catch (error) {
      return String(error.stdout ?? "") + String(error.stderr ?? "");
    }
  };

  const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);

  /** Fresh snapshot as text. The CLI writes it to a file and prints the path. */
  const snapshot = () => {
    const out = pw("snapshot");
    const match = out.match(/\]\(([^)]+\.yml)\)/);
    if (!match) return out;
    try { return readFileSync(match[1], "utf8"); } catch { return out; }
  };

  /**
   * Find the ref of the first control whose accessible name matches.
   * `role` narrows to button/tab/textbox/etc.
   */
  const findRef = (namePattern, role = "button") => {
    const snap = snapshot();
    const re = new RegExp(`${role}\\s+"([^"]*)"[^\\n]*\\[ref=([a-z0-9]+)\\]`, "g");
    for (const m of snap.matchAll(re)) {
      if (new RegExp(namePattern, "i").test(m[1])) return { ref: m[2], name: m[1] };
    }
    return null;
  };

  const clickNamed = (namePattern, role = "button", { required = true } = {}) => {
    const hit = findRef(namePattern, role);
    if (!hit) {
      if (required) console.error(`  ! no ${role} matching /${namePattern}/`);
      return false;
    }
    pw("click", hit.ref);
    return true;
  };

  /** Click by ref directly (when a snapshot was already taken). */
  const click = (ref) => pw("click", ref);
  const type = (text) => pw("type", text);
  const press = (key) => pw("press", key);
  const chapter = (title) => pw("video-chapter", title);
  /** Return ONLY the value the page produced.
   *
   * The CLI prints "### Result\n<value>\n### Ran Playwright code\n<source>",
   * and the echoed source contains every string literal in the script — so a
   * naive `output.includes("DONE")` matches the script, not the answer, and the
   * check passes no matter what the page said. */
  const evalJs = (fn) => {
    const out = pw("eval", fn);
    const start = out.indexOf("### Result");
    if (start === -1) return "";
    const rest = out.slice(start + "### Result".length);
    const end = rest.indexOf("### Ran");
    return (end === -1 ? rest : rest.slice(0, end)).trim();
  };

  /** Focus a field by accessible name, clear it, and type for real. */
  const fillNamed = (namePattern, text) => {
    const hit = findRef(namePattern, "textbox");
    if (!hit) { console.error(`  ! no textbox matching /${namePattern}/`); return false; }
    pw("click", hit.ref);
    pw("press", "ControlOrMeta+a");
    pw("press", "Backspace");
    pw("type", text);
    return true;
  };

  return { pw, sleep, snapshot, findRef, clickNamed, click, type, press, chapter, evalJs, fillNamed };
}

/** The identity shown in every film. */
export const IDENTITY = { name: "Divyam", email: "ada@example.com" };

/** Complete or skip first-run setup so a scene starts in the workspace.
 *
 * Patient on purpose: the Engines step paints only after the runtime inventory
 * resolves, and clicking before that leaves the gate open — which once put a
 * whole film's footage inside the setup dialog. */
export function passOnboarding(d, { name = IDENTITY.name, email = IDENTITY.email } = {}) {
  d.sleep(2000);
  if (!d.evalJs("() => !!document.querySelector('[role=dialog]')").includes("true")) return true;

  d.fillNamed("Your name", name);
  d.sleep(400);
  d.fillNamed("Profile email", email);
  d.sleep(600);

  for (let i = 0; i < 14; i += 1) {
    const state = d.evalJs(`() => {
      const dlg = document.querySelector('[role=dialog]');
      if (!dlg) return 'DONE';
      const next = [...dlg.querySelectorAll('button')].find((b) =>
        ['Continue', 'Continue without email', 'Not now', 'Skip', 'Finish'].includes(b.textContent.trim()) && !b.disabled);
      if (!next) return 'WAIT';
      next.click();
      return 'CLICKED';
    }`);
    if (state.includes("DONE")) { d.sleep(900); return true; }
    d.sleep(state.includes("WAIT") ? 1500 : 1800);
  }
  console.error("  ! onboarding gate never closed");
  return false;
}
