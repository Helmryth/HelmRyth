/** Whether this platform enforces POSIX file modes.
 *
 * Windows does not. NTFS permissions are ACLs; Node reports `0o666` for any
 * writable file and the mode argument to `open(2)` is ignored there. An
 * assertion that a state file is `0o600` is therefore a claim about a guarantee
 * only POSIX makes, and it has to say so rather than fail on the one platform
 * that cannot keep it.
 *
 * The consequence is worth stating rather than hiding behind a skip: on Windows
 * the files this server writes with `mode: 0o600` — profile config, quarantined
 * state, skill manifests — are NOT restricted to the owner. Restricting them
 * there requires setting an ACL, and nothing in this repository does. Guarding
 * the assertion records that gap; it does not close it. */
export const HAS_POSIX_FILE_MODES = process.platform !== "win32";
