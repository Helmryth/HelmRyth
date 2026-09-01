import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react-markdown") || id.includes("remark-gfm")) {
              return "markdown-renderer";
            }
            if (id.includes("react") || id.includes("scheduler")) {
              return "react-vendor";
            }
            if (id.includes("lucide-react")) {
              return "icon-vendor";
            }
            if (id.includes("zod") || id.includes("yaml")) {
              return "data-contracts";
            }
            if (id.includes("posthog-js")) {
              return "analytics";
            }
          }
          if (
            id.includes("/src/components/ChatView.tsx")
            || id.includes("/src/components/GroupView.tsx")
            || id.includes("/src/components/ChatMarkdown.tsx")
            || id.includes("/src/components/Composer.tsx")
            || id.includes("/src/components/TaskPicker.tsx")
            || id.includes("/src/components/ModelPicker.tsx")
            || id.includes("/src/components/CallView.tsx")
            || id.includes("/src/components/GroupCallView.tsx")
            || id.includes("/src/components/Reactions.tsx")
            || id.includes("/src/components/AttachmentPreview.tsx")
          ) {
            return "conversation-core";
          }
          if (
            id.includes("/src/components/Sidebar.tsx")
            || id.includes("/src/components/TeamLibraryPanel.tsx")
            || id.includes("/src/components/CommandPalette.tsx")
            || id.includes("/src/components/ProviderIcons.tsx")
            || id.includes("/src/state/store.ts")
          ) {
            return "shell-core";
          }
        },
      },
    },
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "companion/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.HELMRYTH_UI_PORT) || 5199,
    origin: process.env.HELMRYTH_UI_ORIGIN
      ?? `http://127.0.0.1:${Number(process.env.HELMRYTH_UI_PORT) || 5199}`,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: [
        "**/release/**",
        "**/build/**",
        "**/dist/**",
        "**/electron/resources/**",
        // The documentation app may build in parallel with renderer E2E.
        // Next's generated server tree changes thousands of files and must
        // never reload the Helmryth application under test.
        "**/.next/**",
        // Browser audits deliberately preserve screenshots, traces, and
        // disposable Chromium profiles here. Watching those files can force
        // full-page reloads in the middle of an end-to-end interaction.
        "**/output/**",
      ],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.HELMRYTH_PORT || 8799}`,
        // The core accepts only its exact Host authority. Preserve the
        // renderer's Origin for its exact-origin check, but rewrite Host from
        // Vite's port to the core's port.
        changeOrigin: true,
      },
    },
  },
});
