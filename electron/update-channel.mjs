import path from "node:path";

export const UPDATE_CONFIGURATION_NAME = "app-update.yml";

/** A packaged client may contact an update service only when its build owns
 * an explicit channel configuration. Omitted publishing therefore fails
 * closed instead of falling back to an inherited repository. */
export function resolveUpdateChannel({ isPackaged, resourcesPath, fileExists }) {
  if (!isPackaged) return { available: false, reason: "development" };
  const configurationPath = path.join(resourcesPath, UPDATE_CONFIGURATION_NAME);
  if (!fileExists(configurationPath)) {
    return { available: false, reason: "not-provisioned", configurationPath };
  }
  return { available: true, configurationPath };
}
