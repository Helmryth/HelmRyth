export const HELMRYTH = {
  name: "Helmryth",
  tagline: "The work moves. You hold the helm.",
  descriptor: "A private operating system for autonomous work.",
  vocabulary: {
    bot: "operator",
    bots: "operators",
    group: "crew",
    groups: "crews",
    task: "run",
    tasks: "runs",
    plugin: "capability",
    plugins: "capabilities",
    routine: "cadence",
    routines: "cadences",
    approval: "gate",
    approvals: "gates",
    computer: "workbench",
    inspector: "trace",
    teamMap: "operations map",
    chief: "lead operator",
    skill: "method",
    skills: "methods",
  },
  exampleOperators: [
    { name: "Rivet", role: "Builder", note: "Turns plans into verified deliverables." },
    { name: "Cairn", role: "Research keeper", note: "Keeps evidence and decisions findable." },
    { name: "Vesper", role: "Watch officer", note: "Monitors signals and reports what changed." },
    { name: "Lark", role: "Communications", note: "Writes clearly and keeps people in the loop." },
    { name: "Ledger", role: "Operations", note: "Tracks commitments, gates, and outcomes." },
  ],
} as const;

export type HelmrythVocabulary = typeof HELMRYTH.vocabulary;
