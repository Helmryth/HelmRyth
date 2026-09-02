// Film 02 — Persistent operators.
// An operator is a standing role, not a chat tab: its own engine, sigil, remit,
// workstreams and cost ledger, all of which survive a restart.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";

resetLane({ fresh: true });
seedOperators([
  { name: "Vesper", title: "Watch officer", description: "Watches the release channel and raises anything that needs a decision.", color: "blue" },
  { name: "Cairn", title: "Research keeper", description: "Keeps the evidence file: sources, quotes, and what we already ruled out.", color: "teal" },
  { name: "Forge", title: "Implementation operator", description: "Turns an accepted plan into a reviewed change.", color: "orange" },
]);

const d = openApp("film");
startFilm(d, "02-operators.webm");

d.chapter("A roster, not a list of chat tabs");
d.sleep(3000);

d.chapter("Every operator carries its own remit");
d.clickNamed("Vesper operator");
d.sleep(2600);
d.clickNamed("Open Vesper's operator profile");
d.sleep(3800);
d.evalJs("() => { const s=[...document.querySelectorAll('.overflow-y-auto')].pop(); if(s) s.scrollTop=260; return 1; }");
d.sleep(3000);
d.press("Escape");
d.sleep(1600);

d.chapter("Each one picks its own engine");
d.clickNamed("Claude Sonnet|Sonnet", "button", { required: false });
d.sleep(3400);
d.press("Escape");
d.sleep(1400);

d.chapter("Rename in place — double-click and type");
// The roster row rename is on screen; the profile-panel Name field is below the
// fold, which is why the previous cut captioned a rename nobody could see.
d.evalJs("() => { const t=[...document.querySelectorAll('[aria-label^=\"Rename operator\"]')][0]; if(!t) return 'NO-TARGET'; t.scrollIntoView({block:'center'}); t.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'RENAMING'; }");
d.sleep(2000);
d.type(" · release watch");
d.press("Enter");
d.sleep(3400);

d.chapter("Archive without losing the record");
d.clickNamed("Archive Forge");
d.sleep(2800);
d.clickNamed("Create or import");
d.sleep(1500);
d.clickNamed("Archived operators", "button", { required: false });
d.sleep(2800);
d.clickNamed("Restore Forge", "button", { required: false });
d.sleep(2600);
d.press("Escape");
d.sleep(1800);

d.chapter("The roster is yours to shape");
d.clickNamed("roster density|density", "button", { required: false });
d.sleep(2400);
d.press("Escape");
d.sleep(1800);

endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/02-operators.webm`));
