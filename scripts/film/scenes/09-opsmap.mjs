// Film 09 — Operations map. Who is working, on what, and what they handed to
// each other.
import { resetLane, seedOperators, openApp, startFilm, endFilm, ASSETS, sh, api } from "./scenes.mjs";
resetLane({ fresh: true });
const made = seedOperators([
  { name: "Vesper", title: "Watch officer", description: "Raises what needs a decision.", color: "blue" },
  { name: "Cairn", title: "Research keeper", description: "Holds the evidence file.", color: "teal" },
  { name: "Forge", title: "Implementation operator", description: "Turns a plan into a change.", color: "orange" },
  { name: "Keel", title: "Release lead", description: "Owns the go / no-go call.", color: "purple" },
]);
api("POST", "/api/groups", { name: "Release desk", memberIds: made.slice(0, 3).map((b) => b.id) });
const d = openApp("film");
startFilm(d, "09-opsmap.webm");

d.chapter("Operations map");
d.sleep(2000);
d.clickNamed("Operations map"); d.sleep(4200);

d.chapter("Every operator, every crew, in one frame");
d.sleep(4000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=180; return 1; }");
d.sleep(3600);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=420; return 1; }");
d.sleep(3400);

d.chapter("Shared context — what the crew all sees");
d.clickNamed("Context|Shared context", "button", { required: false });
d.sleep(4200);
d.press("Escape"); d.sleep(2000);
d.evalJs("() => { const s=document.querySelector('main .overflow-y-auto'); if(s) s.scrollTop=0; return 1; }");
d.sleep(2600);
endFilm(d);
console.log(sh(`ls -la ${ASSETS}/raw/09-opsmap.webm`));
