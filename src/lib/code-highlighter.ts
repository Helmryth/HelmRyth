import {
  createBundledHighlighter,
  createSingletonShorthands,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

const THEME = "github-light-default" as const;

const LANGUAGE_LOADERS = {
  bash: () => import("shiki/dist/langs/bash.mjs"),
  c: () => import("shiki/dist/langs/c.mjs"),
  css: () => import("shiki/dist/langs/css.mjs"),
  diff: () => import("shiki/dist/langs/diff.mjs"),
  docker: () => import("shiki/dist/langs/docker.mjs"),
  go: () => import("shiki/dist/langs/go.mjs"),
  graphql: () => import("shiki/dist/langs/graphql.mjs"),
  html: () => import("shiki/dist/langs/html.mjs"),
  java: () => import("shiki/dist/langs/java.mjs"),
  javascript: () => import("shiki/dist/langs/javascript.mjs"),
  json: () => import("shiki/dist/langs/json.mjs"),
  json5: () => import("shiki/dist/langs/json5.mjs"),
  jsonc: () => import("shiki/dist/langs/jsonc.mjs"),
  markdown: () => import("shiki/dist/langs/markdown.mjs"),
  mdx: () => import("shiki/dist/langs/mdx.mjs"),
  powershell: () => import("shiki/dist/langs/powershell.mjs"),
  python: () => import("shiki/dist/langs/python.mjs"),
  rust: () => import("shiki/dist/langs/rust.mjs"),
  sql: () => import("shiki/dist/langs/sql.mjs"),
  toml: () => import("shiki/dist/langs/toml.mjs"),
  tsx: () => import("shiki/dist/langs/tsx.mjs"),
  typescript: () => import("shiki/dist/langs/typescript.mjs"),
  xml: () => import("shiki/dist/langs/xml.mjs"),
  yaml: () => import("shiki/dist/langs/yaml.mjs"),
} as const;

type SupportedLanguage = keyof typeof LANGUAGE_LOADERS;

const LANGUAGE_ALIASES = new Map<string, SupportedLanguage>([
  ["bat", "powershell"],
  ["cjs", "javascript"],
  ["console", "bash"],
  ["cpp", "c"],
  ["c++", "c"],
  ["cts", "typescript"],
  ["gql", "graphql"],
  ["h", "c"],
  ["hh", "c"],
  ["hpp", "c"],
  ["htm", "html"],
  ["js", "javascript"],
  ["md", "markdown"],
  ["mts", "typescript"],
  ["ps", "powershell"],
  ["ps1", "powershell"],
  ["py", "python"],
  ["rs", "rust"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["shellscript", "bash"],
  ["ts", "typescript"],
  ["yml", "yaml"],
  ["zsh", "bash"],
]);

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return Object.hasOwn(LANGUAGE_LOADERS, value);
}

export function resolveHighlightedLanguage(lang: string): SupportedLanguage | null {
  const normalized = lang.trim().toLowerCase();
  if (!normalized) return null;
  if (isSupportedLanguage(normalized)) return normalized;
  return LANGUAGE_ALIASES.get(normalized) ?? null;
}

const createHighlighter = createBundledHighlighter({
  langs: LANGUAGE_LOADERS,
  themes: {
    [THEME]: () => import("shiki/dist/themes/github-light-default.mjs"),
  },
  engine: () => createJavaScriptRegexEngine(),
});

const { codeToHtml } = createSingletonShorthands(createHighlighter);

export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const resolved = resolveHighlightedLanguage(lang);
  if (!resolved) return null;
  return codeToHtml(code, {
    lang: resolved,
    theme: THEME,
  });
}
