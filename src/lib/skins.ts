// Helmryth carries one public identity. Legacy ids are accepted only during
// migration and always normalize to the light surface before first paint.
export const SKIN_IDS = ["helmryth-light"] as const;
export const LEGACY_SKIN_IDS = ["midnight", "atelier", "foundry", "lagoon"] as const;
const KNOWN_SKIN_IDS = [...SKIN_IDS, ...LEGACY_SKIN_IDS] as const;

export type SkinId = (typeof SKIN_IDS)[number];
export type LegacySkinId = (typeof LEGACY_SKIN_IDS)[number];
type KnownSkinId = (typeof KNOWN_SKIN_IDS)[number];

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "helmryth-light", name: "Helmryth Light", tagline: "Editorial instrument panel in warm daylight." },
];

export const DEFAULT_SKIN: SkinId = "helmryth-light";

const KEY = "helmryth-skin";
const LEGACY_KEY = "omb-skin"; // brand-check: allow-legacy
const LEGACY_SKIN_MAP = {
  midnight: DEFAULT_SKIN,
  atelier: DEFAULT_SKIN,
  foundry: DEFAULT_SKIN,
  lagoon: DEFAULT_SKIN,
} satisfies Record<LegacySkinId, SkinId>;

// The input is whatever localStorage handed back — a string this app wrote
// on an earlier run, a value edited by hand, or a leftover from a renamed
// skin. The list is the schema.
function isKnownSkinId(value: string | null | undefined): value is KnownSkinId {
  return KNOWN_SKIN_IDS.some((candidate) => candidate === value);
}

function isLegacySkinId(value: KnownSkinId): value is LegacySkinId {
  return LEGACY_SKIN_IDS.some((candidate) => candidate === value);
}

function normalizeSkinId(id: KnownSkinId): SkinId {
  return isLegacySkinId(id) ? LEGACY_SKIN_MAP[id] : id;
}

function getStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readSkin(): SkinId {
  try {
    const store = getStore();
    const stored = store ? store.getItem(KEY) ?? store.getItem(LEGACY_KEY) : null;
    if (!isKnownSkinId(stored)) return DEFAULT_SKIN;
    return normalizeSkinId(stored);
  } catch {
    return DEFAULT_SKIN;
  }
}

/**
 * Point the document at a skin and remember it. Called once before the first
 * paint (main.tsx) and again on every change from the picker — a stamped
 * attribute rather than a class so it can never collide with Tailwind.
 */
export function applySkin(id: KnownSkinId): void {
  const normalized = normalizeSkinId(id);
  document.documentElement.dataset.skin = normalized;
  try {
    const store = getStore();
    store?.setItem(KEY, normalized);
    store?.removeItem(LEGACY_KEY);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }
  // The one surface CSS cannot reach: on Windows the caption buttons sit in a
  // native overlay the main process paints. Best-effort: a browser tab or an
  // older desktop build has no bridge, and the skin still applies without it.
  try {
    void window.helmryth?.applySkin?.(normalized)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }
}
