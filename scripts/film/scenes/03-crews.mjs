// Film 03 — Crews. Several operators, one brief, one transcript, and a stop
// button that verifiably stops.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([
  { name: "Vesper", title: "Watch officer", description: "Raises what needs a decision.", color: "blue" },
  { name: "Cairn", title: "Research keeper", description: "Holds the evidence file.", color: "teal" },
  { name: "Forge", title: "Implementation operator", description: "Turns a plan into a change.", color: "orange" },
]);
const d = openApp("film");
startFilm(d, "03-crews.webm");

d.chapter("Assemble a crew");
d.sleep(2000);
d.clickNamed("Create or import"); d.sleep(1300);
d.clickNamed("Assemble crew"); d.sleep(2400);
d.fillNamed("name|crew", "Release desk"); d.sleep(1000);
d.evalJs("() => { const dlg=[...document.querySelectorAll('[role=dialog]')].pop(); const rows=[...dlg.querySelectorAll('button')].filter(b=>/Vesper|Cairn|Forge/.test(b.textContent)); rows.slice(0,3).forEach(r=>r.click()); return rows.length; }");
d.sleep(2000);
d.clickNamed("Assemble crew · ", "button", { required: false }); d.sleep(3400);

// A new crew opens on a bearing sheet: it will not take work until you say what
// the work IS. Skipping this is what left the previous cut frozen — the composer
// stays disabled ("Complete crew setup to open this workstream") until it is set.
d.chapter("A crew asks for its bearing before it works");
d.sleep(2000);
d.evalJs("() => { const t=[...document.querySelectorAll('main textarea')].find(x=>/Outcome, ownership/.test(x.placeholder)); if(t) t.focus(); return t ? 'FOCUSED' : 'NO-BEARING-FIELD'; }");
d.sleep(600);
d.type("Decide whether we ship on Friday. Name the risks, own the call, and show the evidence behind it.");
d.sleep(2400);
d.clickNamed("^Set bearing$", "button", { required: false });
d.sleep(4000);

d.chapter("Routing decides who answers");
d.sleep(1000);
d.clickNamed("Full crew|Lead operator|Named operators", "button", { required: false });
d.sleep(2800);
d.press("Escape"); d.sleep(1400);

d.chapter("One brief for the whole crew");
d.evalJs("() => { const t=[...document.querySelectorAll('main textarea')].find(x=>!x.disabled); if(t) t.focus(); return t ? 'FOCUSED:'+(t.placeholder||'').slice(0,30) : 'NO-COMPOSER'; }");
d.sleep(500);
d.type("List every risk of shipping on a Friday you can think of, one per line, and keep going until I stop you.");
d.sleep(1500);
d.press("Enter");

// Wait for the run to actually be in flight before claiming we stop it.
let running = false;
for (let i = 0; i < 18; i += 1) {
  d.sleep(1000);
  const state = d.evalJs("() => { const t=document.body.innerText; return (/Working|Run active|is working/.test(t) ? 'RUNNING' : 'IDLE'); }");
  if (state.includes("RUNNING")) { running = true; break; }
}
console.log("  run in flight:", running);
d.sleep(6000);

d.chapter("Stop it mid-sentence");
d.sleep(1200);
// Stop lives in the header while a crew turn is in flight.
// The crew control is "Stop the active step", not the 1:1 chat's bare "Stop".
const stopped = d.evalJs("() => { const b=[...document.querySelectorAll('button')].find(x=>/stop/i.test((x.getAttribute('aria-label')||x.textContent||'').trim())); if(b){ b.click(); return 'STOPPED:'+((b.getAttribute('aria-label')||b.textContent||'').trim()); } return 'NO-STOP-BUTTON:'+[...document.querySelectorAll('button')].map(x=>(x.getAttribute('aria-label')||x.textContent||'').trim()).filter(Boolean).slice(0,12).join('|'); }");
console.log("  stop:", stopped.trim());
d.sleep(5000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(4000);

d.chapter("The crew keeps one shared transcript");
d.sleep(3000);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/03-crews.webm`));
