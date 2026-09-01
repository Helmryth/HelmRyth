const STRING_VALUE_TAG = "[object String]";
const FUNCTION_TAG = "[object Function]";
const ASYNC_FUNCTION_TAG = "[object AsyncFunction]";

function parseCallable(value) {
  const tag = Object.prototype.toString.call(value);
  if (tag !== FUNCTION_TAG && tag !== ASYNC_FUNCTION_TAG) return null;
  return value;
}

function parseExternalWebUrl(rawUrl) {
  if (Object(rawUrl) === rawUrl || Object.prototype.toString.call(rawUrl) !== STRING_VALUE_TAG) {
    throw new Error("A web address is required");
  }
  const requestedUrl = rawUrl.trim();
  if (!requestedUrl) throw new Error("A web address is required");

  let url;
  try {
    url = new URL(requestedUrl);
  } catch {
    throw new Error("That web address is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only web links can be opened");
  }
  return url;
}

async function openExternalWebUrl(openExternal, rawUrl) {
  const callable = parseCallable(openExternal);
  if (callable === null) throw new Error("The external browser is unavailable");
  const url = parseExternalWebUrl(rawUrl);
  await callable(url.toString());
  return true;
}

function createExternalWebWindowOpenHandler(openExternal, { reportError } = {}) {
  const report = parseCallable(reportError);
  const callable = parseCallable(openExternal);
  return ({ url }) => {
    if (callable === null) return { action: "deny" };
    let external;
    try {
      external = parseExternalWebUrl(url);
    } catch {
      return { action: "deny" };
    }
    try {
      void Promise.resolve(callable(external.toString())).catch((error) => report?.(error, external));
    } catch (error) {
      report?.(error, external);
    }
    return { action: "deny" };
  };
}

export { createExternalWebWindowOpenHandler, openExternalWebUrl, parseExternalWebUrl };
