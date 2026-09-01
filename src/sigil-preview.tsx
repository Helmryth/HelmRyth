import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SigilAvatar } from "@/components/Avatar";
import {
  OPERATOR_SIGNAL_COLOR_NAMES,
  OPERATOR_SIGIL_MOTIONS,
  PICKABLE_STATES,
  SIGIL_COLORS,
  STATE_GROUPS,
  type SigilColor,
  type SigilMotion,
  type SigilState,
} from "@/lib/sigil";
import "./styles.css";
import "./sigil-preview.css";

const COLOR_LABELS = {
  green: "Moss",
  blue: "Harbor",
  red: "Vermilion",
  orange: "Ember",
  purple: "Cinder",
  cyan: "Petrol",
  pink: "Clay",
  yellow: "Brass",
  teal: "Tide",
  coral: "Kiln",
} satisfies Record<(typeof OPERATOR_SIGNAL_COLOR_NAMES)[number], string>;

const SCENARIOS = new Map<SigilState, string>([
  ["idle", "General coverage"],
  ["happy", "Welcoming lead"],
  ["curious", "Awaiting direction"],
  ["drowsy", "Long-running queue"],
  ["working", "Execution in flight"],
  ["thinking", "Evidence and analysis"],
  ["listening", "Voice or live intake"],
  ["sleeping", "Paused surface"],
  ["suspicious", "Review and audit"],
  ["proud", "Verified completion"],
]);

const MOTION_SCENARIOS = {
  arrive: "New operator commissioned",
  switch: "Active surface changes",
  customize: "Identity mark refreshed",
  alert: "Gate or fault raised",
  thinking: "Evidence is being weighed",
  working: "Run advances",
  launch: "Workbench spins up",
  success: "Step settles cleanly",
  celebrate: "Run closes with proof",
  blink: "Fresh note lands",
  surprise: "Unread movement arrives",
  failure: "Action breaks and reports back",
} satisfies Record<Exclude<SigilMotion, "none">, string>;

const MOTION_COLORS: SigilColor[] = [
  "red",
  "blue",
  "purple",
  "orange",
  "cyan",
  "yellow",
  "teal",
  "green",
  "coral",
  "pink",
  "blue",
  "red",
];

function MotionCard({
  motion,
  index,
  replayAll,
  color,
}: {
  motion: Exclude<SigilMotion, "none">;
  index: number;
  replayAll: number;
  color: SigilColor;
}) {
  const [replayOne, setReplayOne] = useState(0);

  return (
    <article className="motion-card">
      <div className="motion-stage">
        <SigilAvatar
          color={color}
          state="idle"
          size={176}
          motion={motion}
          motionKey={replayAll * 100 + replayOne}
          label={`${motion} motion`}
        />
      </div>
      <footer className="motion-meta">
        <div>
          <span className="motion-number">{String(index + 1).padStart(2, "0")}</span>
          <h2>{motion}</h2>
          <p>{MOTION_SCENARIOS[motion]}</p>
        </div>
        <button type="button" onClick={() => setReplayOne((value) => value + 1)}>
          Replay
        </button>
      </footer>
    </article>
  );
}

function Preview() {
  const [replayAll, setReplayAll] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => setReplayAll((value) => value + 1), 4600);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <main className="preview-shell">
      <header className="preview-header">
        <div>
          <p className="eyebrow">Helmryth identity atlas</p>
          <h1>Operator sigils and motion states</h1>
          <p className="intro">
            Helmryth operators are rendered as framed instruments, not faces or mascots.
            These studies verify that each state stays legible in motion, in still frames, and
            across the ten stored color channels the app already persists.
          </p>
        </div>
        <button className="replay-all" type="button" onClick={() => setReplayAll((value) => value + 1)}>
          Replay all states
        </button>
      </header>

      <section className="motion-grid" aria-label="Sigil motion atlas">
        {OPERATOR_SIGIL_MOTIONS.map((motion, index) => (
          <MotionCard
            key={motion}
            motion={motion}
            index={index}
            replayAll={replayAll}
            color={MOTION_COLORS[index]}
          />
        ))}
      </section>

      <section className="expression-library" aria-labelledby="expression-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Stored palette × steady states</p>
            <h2 id="expression-heading">Color ledger</h2>
          </div>
          <p>Each label on the left is the human-facing Helmryth palette name for an existing stored color id.</p>
        </div>

        <div className="matrix-wrap">
          <div className="matrix">
            <div className="corner-label">Palette ↓ / state →</div>
            {PICKABLE_STATES.map((state) => (
              <div className="column-label" key={state}>
                <strong>{state}</strong>
                <span>{SCENARIOS.get(state) ?? "Reserved signal"}</span>
              </div>
            ))}

            {OPERATOR_SIGNAL_COLOR_NAMES.map((color) => (
              <div className="matrix-row" key={color}>
                <div className="row-label">
                  <span className="swatch" style={{ background: SIGIL_COLORS[color] }} />
                  <strong>{COLOR_LABELS[color]}</strong>
                  <code>{color}</code>
                </div>
                {PICKABLE_STATES.map((state) => (
                  <div className="sigil-cell" key={`${color}-${state}`}>
                    <SigilAvatar color={color} state={state} size={86} label={`${COLOR_LABELS[color]} ${state} sigil`} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="groups-wrap">
          {Object.entries(STATE_GROUPS).map(([group, states]) => (
            <section key={group} className="group-card">
              <h3>{group}</h3>
              <div className="group-chips">
                {states.map((state) => (
                  <span key={state} className="group-chip">
                    {state}
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
