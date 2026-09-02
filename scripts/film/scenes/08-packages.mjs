// Film 08 — Crew packages. Export the roster you have, load a complete crew from
// the library, then take that import back in one click.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh } from "./scenes.mjs";
resetLane({ fresh: true });
seedOperators([
  { name: "Vesper", title: "Watch officer", description: "Raises what needs a decision.", color: "blue" },
  { name: "Cairn", title: "Research keeper", description: "Holds the evidence file.", color: "teal" },
  { name: "Forge", title: "Implementation operator", description: "Turns a plan into a change.", color: "orange" },
]);
const d = openApp("film");
startFilm(d, "08-packages.webm");

d.chapter("Export the team you have");
d.sleep(2400);
d.clickNamed("Create or import"); d.sleep(1800);
d.clickNamed("Export roster"); d.sleep(4200);
// the toast names how many operators left the building
d.sleep(2600);

d.chapter("A library of complete crews");
d.clickNamed("Create or import"); d.sleep(1500);
d.clickNamed("Crew library"); d.sleep(4500);
d.sleep(2400);

d.chapter("Load one and it arrives whole");
d.clickNamed("Load Release Foundry|Load Product Compass|^Load ", "button", { required: false });
d.sleep(7000);
d.evalJs("() => { const s=[...document.querySelectorAll('.overflow-y-auto')].pop(); if(s) s.scrollTop=s.scrollHeight; return 1; }");
d.sleep(3000);

d.chapter("Every import is a transaction — take it back");
d.clickNamed("^Undo$", "button", { required: false });
d.sleep(5000);

d.chapter("Or bring your own — Markdown or JSON");
d.clickNamed("Create or import"); d.sleep(1400);
d.clickNamed("Crew library"); d.sleep(3400);
d.evalJs("() => { const t=document.getElementById('crew-source-tab-import'); if(t) t.click(); return 1; }");
d.sleep(4000);
d.press("Escape"); d.sleep(1800);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/08-packages.webm`));
