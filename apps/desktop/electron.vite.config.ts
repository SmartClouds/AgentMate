import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// electron-vite externalizes dependencies on its own (build.externalizeDeps
// defaults to true), but that alone has been unreliable at keeping `electron`
// itself external on this Vite/electron-vite version (it got inlined,
// which breaks `app`/`BrowserWindow` since they resolve to the npm
// install-shim instead of Electron's native runtime hook). Force node
// built-ins, electron, and native modules external explicitly as a backstop.
const forcedExternals = [
  'electron',
  'node-pty',
  'better-sqlite3',
  // The vector search extension the Help index loads into SQLite. It finds its per-platform
  // vec0 library with require.resolve at runtime, so it has to stay in node_modules.
  'sqlite-vec',
  // Local speech-to-text. transformers.js pulls in onnxruntime-node, which
  // dlopen's prebuilt native binaries, so it must stay external. Otherwise
  // Rollup tries to bundle the .node/.dll files.
  '@huggingface/transformers',
  'onnxruntime-node',
  // ssh2's optional perf accelerator. Its own require() of the prebuilt binary is
  // unguarded, and the binary is intentionally not built here (see pnpm-workspace.yaml's
  // allowBuilds), so bundling it fails at build time even though ssh2 already wraps its own
  // `require('cpu-features')` in a try/catch and runs fine without it at actual runtime.
  'cpu-features',
  // Postman's request engine loads parts of itself by path at runtime (the script sandbox ships
  // as a prebuilt string it evaluates), so it is left in node_modules rather than bundled.
  'postman-runtime',
  'postman-collection',
  // The SignalR client picks its Node helpers at runtime (`require('eventsource')`,
  // `require('tough-cookie')`), which only resolve from its own folder in pnpm's store, not
  // from out/main. Bundled, the first hub call fails with "Cannot find module 'eventsource'".
  '@microsoft/signalr',
  /^node:/,
];

export default defineConfig({
  main: {
    resolve: {
      alias: {
        // The package's "module" field points at a file it does not ship.
        '@xterm/headless': resolve(
          __dirname,
          'node_modules/@xterm/headless/lib-headless/xterm-headless.mjs',
        ),
      },
    },
    build: {
      // Bundled rather than resolved at runtime: the terminal host can run from a copy
      // outside the install folder that only carries node-pty alongside it.
      externalizeDeps: { exclude: ['@xterm/headless', '@xterm/addon-serialize'] },
      rollupOptions: {
        external: forcedExternals,
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Separate entry: local-log usage scanning runs in a worker thread so
          // parsing hundreds of MB of CLI transcripts can't block main-process
          // IPC. Loaded by path from main, so it needs its own bundle.
          usageScanWorker: resolve(__dirname, 'src/main/usage/usageScanWorker.ts'),
          // Same for the project Usage tab, which parses every transcript of one project.
          projectUsageWorker: resolve(__dirname, 'src/main/agents/projectUsageWorker.ts'),
          // Same reasoning for unpacking the CodeQL CLI: the archive is around 400 MB and
          // several thousand files, so extracting it on main would freeze the UI for the
          // best part of a minute.
          codeqlExtractWorker: resolve(__dirname, 'src/main/security/codeqlExtractWorker.ts'),
          // The background terminal host. It runs as its own detached process so terminals
          // survive the app quitting or updating, which means it is started by path.
          ptyHost: resolve(__dirname, 'src/main/ptyHost/hostEntry.ts'),
          // The API Client runs requests and their scripts in a utility process of its own, so a
          // runaway script from an imported collection cannot freeze main. Started by path.
          apiRunnerHost: resolve(__dirname, 'src/main/apiClient/runnerHost.ts'),
          // Whisper loads and decodes synchronously, for minutes with the large model, so it runs
          // in a utility process of its own instead of freezing main. Started by path.
          speechHost: resolve(__dirname, 'src/main/speech/speechHost.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: forcedExternals,
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          // Electron's sandboxed preload loader (sandbox: true) cannot load
          // ESM. It needs CommonJS, unlike the main process which supports ESM.
          format: 'cjs',
          entryFileNames: '[name].js',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // The startup splash: a separate page with no React so it paints at once.
          splash: resolve(__dirname, 'src/renderer/splash.html'),
        },
        // Most of this build is Vite's own asset and worker plugins (Monaco's workers above all),
        // so on a slow CI runner Rolldown's "time spent in plugins" hint fires every run without
        // anything to act on.
        checks: { pluginTimings: false },
      },
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [react()],
  },
});
