// Helmryth operator names are ordered, local, and deterministic. The first
// operator on a new installation is Rivet; later operators advance through a
// vocabulary of instruments, structures, field marks, and working forms.
// Existing or explicitly supplied names never pass through this generator.
const OPERATOR_NAMES = [
  "Rivet",
  "Cairn",
  "Vesper",
  "Tiller",
  "Caliper",
  "Meridian",
  "Gimbal",
  "Keel",
  "Plumb",
  "Sextant",
  "Trestle",
  "Pylon",
  "Fathom",
  "Spline",
  "Yoke",
  "Ferrule",
  "Capstan",
  "Bezel",
  "Dovetail",
  "Ledger",
  "Waymark",
  "Kiln",
  "Lattice",
  "Verge",
  "Torsion",
  "Fulcrum",
  "Quoin",
  "Datum",
  "Strake",
  "Boreal",
  "Palisade",
  "Cordage",
] as const;

/** Choose the first unused Helmryth operator name, case-insensitively. */
export function pickOperatorName(taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const available = OPERATOR_NAMES.find((name) => !used.has(name.toLowerCase()));
  if (available) return available;

  // The vocabulary can expand without changing the stable exhaustion rule:
  // fill suffix 2 across the roster before moving on to suffix 3.
  for (let suffix = 2; ; suffix += 1) {
    for (const name of OPERATOR_NAMES) {
      const candidate = `${name} ${suffix}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
  }
}
