const DEFAULT_DEVELOPMENT_ORIGIN = "http://127.0.0.1:5199";

function exactHttpOrigin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an exact http(s) origin`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new Error(`${label} must be an exact http(s) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

export function developmentRendererOrigin(environment = process.env) {
  const desktop = environment.HELMRYTH_DESKTOP_URL;
  const configured = environment.HELMRYTH_UI_ORIGIN;
  const portDefault = environment.HELMRYTH_UI_PORT
    ? `http://127.0.0.1:${environment.HELMRYTH_UI_PORT}`
    : DEFAULT_DEVELOPMENT_ORIGIN;
  const desktopOrigin = exactHttpOrigin(desktop ?? configured ?? portDefault, "HELMRYTH_DESKTOP_URL");
  if (configured) {
    const configuredOrigin = exactHttpOrigin(configured, "HELMRYTH_UI_ORIGIN");
    if (configuredOrigin !== desktopOrigin) {
      throw new Error("HELMRYTH_DESKTOP_URL and HELMRYTH_UI_ORIGIN must use the same exact origin");
    }
  }
  return desktopOrigin;
}

export function packagedRendererOrigin(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid core port");
  return `http://127.0.0.1:${port}`;
}
