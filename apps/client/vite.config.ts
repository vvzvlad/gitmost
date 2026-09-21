import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { compression } from "vite-plugin-compression2";
import * as path from "path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { buildDefineEnv } from "./src/lib/client-config-keys";

const envPath = path.resolve(process.cwd(), "..", "..");

// Resolve the version string shown in the UI.
// Priority: explicit APP_VERSION env (injected by Docker/CI, where .git is absent),
// then `git describe` for local builds, then the package.json version as a fallback.
function resolveAppVersion(cwd: string): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git describe --tags --always", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return `v${process.env.npm_package_version ?? "0.0.0"}`;
  }
}

// Emit <outDir>/version.json = { "version": appVersion } so the server can read
// the exact same build id the bundle was compiled with. The value is the SAME
// `appVersion` fed into `define.APP_VERSION`, so version.json and the baked-in
// global are identical by construction — the single source of truth (no
// runtime-env second copy that could drift and cause a false version mismatch).
function versionJsonPlugin(version: string): Plugin {
  let outDir = "dist";
  return {
    name: "emit-version-json",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      const root = path.resolve(process.cwd(), outDir);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "version.json"),
        JSON.stringify({ version }),
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const appVersion = resolveAppVersion(envPath);
  const env = loadEnv(mode, envPath, "");
  const { APP_URL } = env;

  return {
    define: {
      // #638 finding 1 — GENERATED from `CLIENT_CONFIG_KEYS`, never hand-listed.
      // In dev `getConfigValue` reads `process.env`, which vite replaces with
      // this static object, so a key missing here is unreachable in dev whatever
      // `.env` says — that is how `isLocalFirstEnabled()` stayed false through
      // every phase 1-2 dev verification. Deriving the object from the same list
      // the drift test checks against `config.ts` keeps a new flag from ever
      // being silently dev-dead again. See client-config-keys.ts for why the
      // allowlist must stay an allowlist (loadEnv with an empty prefix returns
      // the full server env, secrets included).
      "process.env": buildDefineEnv(env),
      APP_VERSION: JSON.stringify(appVersion),
    },
    plugins: [
      react(),
      versionJsonPlugin(appVersion),
      // Emit .br and .gz next to every built asset so the server can serve the
      // precompressed copy (see @fastify/static preCompressed in static.module.ts).
      compression({
        algorithms: ["brotliCompress", "gzip"],
        // vite-plugin-compression2's default `include` only covers text-ish
        // bundle output (js/mjs/json/css/html/svg/…). Extend it with the large
        // VAD binaries copied from public/vad (.wasm ~26MB, .onnx ~2.3MB) so
        // they are brotli/gzip'd once at build time and served via
        // @fastify/static preCompressed — otherwise @fastify/compress would
        // re-brotli them on EVERY request. The default types are repeated here
        // because setting `include` replaces (does not extend) the default.
        include: /\.(html|xml|css|json|js|mjs|svg|yaml|yml|toml|wasm|onnx)$/,
        // index.html is rewritten at server boot (window.CONFIG injection); a
        // precompressed copy would go stale — NEVER precompress it.
        exclude: [/index\.html$/],
      }),
    ],
    build: {
      // The Lucide icon catalog (issue #696) is a single ~700 KB (raw)
      // dynamically-imported chunk (lucide-catalog.generated-*.js), well over
      // Vite's default 500 KB warning threshold — but it is lazy (loaded only
      // when the icon picker first opens) and compresses to ~128 KB brotli. Raise
      // the limit so that intentional chunk stops spamming a warning every build.
      chunkSizeWarningLimit: 1000,
      rolldownOptions: {
        output: {
          advancedChunks: {
            groups: [
              {
                name: "vendor-mantine",
                test: /[\\/]node_modules[\\/]@mantine[\\/]/,
              },
              // NOTE: TipTap/ProseMirror/Yjs are intentionally NOT force-grouped
              // into a single vendor chunk. Doing so backfires: rolldown co-locates
              // a small module shared with the (eager) react-i18next runtime into
              // that group chunk, which then drags the whole ~590KB editor engine
              // into the eager modulepreload graph. Left to the default splitting,
              // the editor engine stays in lazily-loaded chunks pulled only by the
              // route-split editor/share pages. KaTeX is safe to group (nothing
              // eager references it).
              // KaTeX in its own stable chunk; loaded on demand by the lazy math
              // node views (never in the startup path).
              {
                name: "vendor-katex",
                test: /[\\/]node_modules[\\/]katex[\\/]/,
              },
            ],
          },
        },
      },
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
    server: {
      proxy: {
        "/api": {
          target: APP_URL,
          changeOrigin: false,
        },
        "/socket.io": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
        "/collab": {
          target: APP_URL,
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  };
});
