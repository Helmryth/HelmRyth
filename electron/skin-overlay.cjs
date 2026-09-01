// Native caption buttons are outside CSS, so the main process mirrors the
// sole light-first Helmryth surface here. Values are opaque because Windows'
// title-bar overlay rejects alpha.
"use strict";

const SKIN_CHROME = Object.freeze({
  helmryth: Object.freeze({ color: "#f6f1e7", symbolColor: "#526071" }),
});

const DEFAULT_SKIN = "helmryth";
const LEGACY_SKIN_IDS = new Set(["midnight", "atelier", "foundry", "lagoon"]);

/** Older persisted ids decode to the new identity without exposing their
 * themes as choices. Unknown input also falls back safely. */
function skinChrome(_skin) {
  return SKIN_CHROME[DEFAULT_SKIN];
}

/** True for the active id and the finite set of decode-only legacy ids. */
function isKnownSkin(skin) {
  return Object.hasOwn(SKIN_CHROME, skin) || LEGACY_SKIN_IDS.has(skin);
}

module.exports = { SKIN_CHROME, DEFAULT_SKIN, skinChrome, isKnownSkin };
