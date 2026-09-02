// Film 01 — First run to first answer.
// A genuinely cold profile: setup, the live engine inventory, your first
// operator, and a real streamed reply from a real CLI. Nothing is stubbed.
import { execFileSync } from "node:child_process";
import { makeDriver, IDENTITY } from "./drive.mjs";
import { REPO } from "../paths.mjs";
const ASSETS = `${REPO}/output/readme-assets`;
const UI = "http://127.0.0.1:5300";
const LANE = "demo";
const d = makeDriver("film");
const sh = (cmd) => { try { return execFileSync("bash", ["-lc", cmd], { encoding: "utf8" }); } catch (e) { return String(e.stdout ?? ""); } };

// A cold start is the point of this film, so wipe the lane's profile first.
sh(`kill $(cat ${REPO}/output/e2e-20260831/lanes/${LANE}/core.pid 2>/dev/null) 2>/dev/null; sleep 1`);
sh(`rm -rf ${REPO}/output/e2e-20260831/lanes/${LANE}/profile && mkdir -p ${REPO}/output/e2e-20260831/lanes/${LANE}/profile`);
sh(`bash ${REPO}/output/e2e-20260831/stack.sh ${LANE} 8300 5300 >/dev/null 2>&1`);
sh(`cp ${ASSETS}/titlecard.html ${REPO}/dist/titlecard.html`);
d.sleep(2000);

d.pw("open", "--headed", UI);
d.sleep(4000);
d.pw("resize", "1280", "800");
d.sleep(1200);

d.pw("video-show-actions", "--duration", "1100", "--position", "top-right", "--cursor", "pointer");
d.pw("video-start", `${ASSETS}/raw/01-first-run.webm`, "--size", "1280x800");

// ── 1. Identity ────────────────────────────────────────────────────────────
d.chapter("First run — who is at the helm");
d.sleep(1600);
d.fillNamed("Your name", IDENTITY.name);
d.sleep(900);
d.fillNamed("Profile email", IDENTITY.email);
d.sleep(1400);
d.clickNamed("^Continue$");
d.sleep(2200);

// ── 2. Engines ─────────────────────────────────────────────────────────────
d.chapter("Your engines — discovered, not configured");
d.sleep(3200);
d.evalJs("() => { const m=document.querySelector('[role=dialog] .overflow-y-auto, [role=dialog]'); if(m) m.scrollTop = 220; return 1; }");
d.sleep(2600);
d.clickNamed("^Continue$|^Next$|^Not now$|^Skip$");
d.sleep(2400);

// ── 3. Anything else the gate asks for ─────────────────────────────────────
for (let i = 0; i < 3; i += 1) {
  const open = d.evalJs("() => !!document.querySelector('[role=dialog]')");
  if (!open.includes("true")) break;
  d.clickNamed("^Continue$|^Not now$|^Skip$|^Finish$", "button", { required: false });
  d.sleep(1800);
}
d.sleep(1200);

// ── 4. The workspace ───────────────────────────────────────────────────────
d.chapter("The workspace");
d.sleep(2200);

// ── 5. A real direction, a real answer ─────────────────────────────────────
d.chapter("A real direction — and a real answer");
d.evalJs("() => { const t=document.querySelector('main textarea'); if(t) t.focus(); return 1; }");
d.sleep(700);
d.type("In two sentences: what should I hand to a persistent operator that I would never hand to a chat window?");
d.sleep(1800);
d.press("Enter");

// let the live model actually answer on camera
d.sleep(22000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(4000);

d.chapter("That run is now a durable record");
d.sleep(2600);

d.pw("video-stop");
d.sleep(2500);
console.log(sh(`ls -la ${ASSETS}/raw/01-first-run.webm`));
