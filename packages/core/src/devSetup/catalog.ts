import type { DevItem, DevItemId, DevOs, DevRecipe, DevStack, DevStackId } from './types.js';

/**
 * What a developer needs to work on Runova and on the projects it manages, grouped into stacks
 * the user picks from. Adding a tool is one entry here: detection, install recipes per OS and the
 * dependencies between items all live in this data, so nothing else needs to learn about it.
 *
 * Order matters. The checklist lists items in this order and the tests require a dependency to
 * come before the item that needs it.
 */

export const DEV_STACKS: readonly DevStack[] = [
  {
    id: 'essentials',
    name: 'Essentials',
    description: 'Git, Node.js, npm and the GitHub CLI. Everything else builds on these.',
    alwaysOn: true,
  },
  {
    id: 'dotnet',
    name: '.NET',
    description: 'The .NET SDK and the Entity Framework tool, for C# projects.',
  },
  {
    id: 'flutter',
    name: 'Flutter + Android',
    description: 'Flutter, Dart, Java and the Android SDK with an emulator, for mobile apps.',
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Docker Desktop and what it needs, for running containers.',
  },
  {
    id: 'studio',
    name: 'Studio',
    description:
      'ffmpeg and ffprobe, which Studio renders and measures videos with, and its local voices.',
  },
];

/** The same recipes on every OS, for the tools that install the same way everywhere. */
function everyOs(...recipes: DevRecipe[]): Partial<Record<DevOs, readonly DevRecipe[]>> {
  return { win32: recipes, darwin: recipes, linux: recipes };
}

/** The sdkmanager system image ABI is filled in per CPU when the install runs. */
export const ANDROID_PLATFORM_PACKAGE = 'platforms;android-36';
export const ANDROID_SYSTEM_IMAGE_PACKAGE = 'system-images;android-36;google_apis;{abi}';

export const DEV_ITEMS: readonly DevItem[] = [
  // ---------------------------------------------------------------- Essentials
  {
    id: 'homebrew',
    name: 'Homebrew',
    description: 'The package manager most Mac tools are installed with.',
    stack: 'essentials',
    os: ['darwin'],
    detect: {
      kind: 'command',
      command: 'brew',
      args: ['--version'],
      fallbackPaths: ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
    },
    recipes: {
      darwin: [
        {
          kind: 'terminal-only',
          command:
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          note: 'The installer asks for your password, so it has to run in a terminal.',
        },
      ],
    },
    manualUrl: 'https://brew.sh',
  },
  {
    id: 'xcode-clt',
    name: 'Xcode Command Line Tools',
    description: 'Apple compilers and Git. Most developer tools on a Mac need them.',
    stack: 'essentials',
    os: ['darwin'],
    detect: { kind: 'command', command: 'xcode-select', args: ['-p'], noVersion: true },
    recipes: {
      darwin: [
        {
          kind: 'terminal-only',
          command: 'xcode-select --install',
          note: 'macOS opens a window to finish the install. Come back and check again after.',
        },
      ],
    },
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Version control. Clones repositories and tracks every change.',
    stack: 'essentials',
    minVersion: '2.30.0',
    detect: {
      kind: 'command',
      command: 'git',
      args: ['--version'],
      fallbackPaths: ['%ProgramFiles%\\Git\\cmd\\git{exe}'],
      // Without the Command Line Tools, running git on a Mac opens the system install dialog.
      guard: { os: 'darwin', item: 'xcode-clt' },
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'Git.Git' }],
      darwin: [{ kind: 'bundled', with: 'xcode-clt' }],
      linux: [{ kind: 'pkg', apt: ['git'], dnf: ['git'], pacman: ['git'] }],
    },
    manualUrl: 'https://git-scm.com/downloads',
  },
  {
    id: 'node',
    name: 'Node.js',
    description: 'Runs JavaScript outside the browser. Runova and most web tooling need it.',
    stack: 'essentials',
    minVersion: '22.12.0',
    detect: {
      kind: 'command',
      command: 'node',
      args: ['--version'],
      fallbackPaths: ['%ProgramFiles%\\nodejs\\node{exe}'],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'OpenJS.NodeJS.LTS' }],
      darwin: [{ kind: 'brew', formula: 'node' }],
      linux: [
        {
          kind: 'pkg',
          apt: ['nodejs', 'npm'],
          dnf: ['nodejs'],
          pacman: ['nodejs', 'npm'],
          note: 'Your distribution may ship an older Node.js. If it stays below 22.12, use the download page.',
        },
      ],
    },
    manualUrl: 'https://nodejs.org/en/download',
  },
  {
    id: 'npm',
    name: 'npm',
    description: 'Installs JavaScript packages. It comes with Node.js.',
    stack: 'essentials',
    minVersion: '10.9.0',
    detect: { kind: 'command', command: 'npm', args: ['--version'] },
    recipes: everyOs({ kind: 'bundled', with: 'node' }),
    manualUrl: 'https://nodejs.org/en/download',
  },
  {
    id: 'gh',
    name: 'GitHub CLI',
    description: 'Opens pull requests, reads issues and signs in to GitHub from the terminal.',
    stack: 'essentials',
    minVersion: '2.40.0',
    detect: {
      kind: 'command',
      command: 'gh',
      args: ['--version'],
      fallbackPaths: ['%ProgramFiles%\\GitHub CLI\\gh{exe}'],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'GitHub.cli' }],
      darwin: [{ kind: 'brew', formula: 'gh' }],
      linux: [{ kind: 'pkg', apt: ['gh'], dnf: ['gh'], pacman: ['github-cli'] }],
    },
    manualUrl: 'https://cli.github.com',
  },
  {
    id: 'pnpm',
    name: 'pnpm',
    description: 'A faster package manager. The Runova repository itself is built with it.',
    stack: 'essentials',
    optional: true,
    dependsOn: ['npm'],
    detect: { kind: 'command', command: 'pnpm', args: ['--version'] },
    recipes: everyOs({ kind: 'npm-global', pkg: 'pnpm' }),
    manualUrl: 'https://pnpm.io/installation',
  },
  {
    id: 'bun',
    name: 'Bun',
    description:
      'A JavaScript runtime and package manager in one. Projects with a bun.lock use it.',
    stack: 'essentials',
    optional: true,
    // Off Windows it installs through npm.
    dependsOn: ['npm'],
    detect: {
      kind: 'command',
      command: 'bun',
      args: ['--version'],
      // Where Bun's own install script puts it.
      fallbackPaths: ['~/.bun/bin/bun{exe}'],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'Oven-sh.Bun' }],
      // The Homebrew formula lives in Bun's own tap, which the brew recipe cannot name.
      darwin: [{ kind: 'npm-global', pkg: 'bun' }],
      linux: [{ kind: 'npm-global', pkg: 'bun' }],
    },
    manualUrl: 'https://bun.sh/docs/installation',
  },
  {
    id: 'gh-auth',
    name: 'GitHub sign-in',
    description: 'Signs the GitHub CLI in to your account so it can reach private repositories.',
    stack: 'essentials',
    optional: true,
    dependsOn: ['gh'],
    detect: { kind: 'command', command: 'gh', args: ['auth', 'status'], noVersion: true },
    recipes: everyOs({
      kind: 'terminal-only',
      command: 'gh auth login --web',
      note: 'Sign-in opens your browser and asks for a code, so it runs in a terminal.',
    }),
  },

  // ---------------------------------------------------------------------- .NET
  {
    id: 'dotnet-sdk',
    name: '.NET SDK',
    description: 'Builds and runs C# projects. The Runova server component targets .NET 10.',
    stack: 'dotnet',
    minVersion: '10.0.100',
    detect: {
      kind: 'command',
      command: 'dotnet',
      args: ['--version'],
      fallbackPaths: [
        '%ProgramFiles%\\dotnet\\dotnet{exe}',
        '/usr/local/share/dotnet/dotnet',
        '/usr/share/dotnet/dotnet',
        '~/.dotnet/dotnet',
      ],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'Microsoft.DotNet.SDK.10' }],
      darwin: [{ kind: 'brew-cask', cask: 'dotnet-sdk', needsAdmin: true }],
      linux: [
        {
          kind: 'pkg',
          apt: ['dotnet-sdk-10.0'],
          dnf: ['dotnet-sdk-10.0'],
          pacman: ['dotnet-sdk'],
          note: 'Some distributions need an extra package source for .NET 10.',
        },
      ],
    },
    manualUrl: 'https://dotnet.microsoft.com/download',
  },
  {
    id: 'dotnet-ef',
    name: 'Entity Framework tool',
    description: 'The dotnet ef command, for database migrations in .NET projects.',
    stack: 'dotnet',
    optional: true,
    dependsOn: ['dotnet-sdk'],
    detect: {
      kind: 'command',
      command: 'dotnet-ef',
      args: ['--version'],
      fallbackPaths: ['~/.dotnet/tools/dotnet-ef{exe}'],
    },
    recipes: everyOs({ kind: 'dotnet-tool', pkg: 'dotnet-ef' }),
    manualUrl: 'https://learn.microsoft.com/ef/core/cli/dotnet',
  },

  // ----------------------------------------------------------- Flutter + Android
  {
    id: 'jdk17',
    name: 'Java 17 (JDK)',
    description: 'The Java compiler that Android builds and the SDK tools run on.',
    stack: 'flutter',
    minVersion: '17',
    detect: {
      kind: 'command',
      command: 'javac',
      args: ['-version'],
      majorOnly: true,
      fallbackPaths: ['%JAVA_HOME%/bin/javac{exe}'],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'EclipseAdoptium.Temurin.17.JDK' }],
      darwin: [{ kind: 'brew-cask', cask: 'temurin@17', needsAdmin: true }],
      linux: [
        {
          kind: 'pkg',
          apt: ['openjdk-17-jdk'],
          dnf: ['java-17-openjdk-devel'],
          pacman: ['jdk17-openjdk'],
        },
      ],
    },
    manualUrl: 'https://adoptium.net/temurin/releases/?version=17',
  },
  {
    id: 'flutter',
    name: 'Flutter SDK',
    description: 'Builds mobile, web and desktop apps from one codebase. Includes Dart.',
    stack: 'flutter',
    minVersion: '3.35.0',
    dependsOn: ['git'],
    detect: { kind: 'resolver', id: 'flutter' },
    recipes: everyOs({ kind: 'managed', installer: 'flutter-archive' }),
    manualUrl: 'https://docs.flutter.dev/get-started/install',
  },
  {
    id: 'dart',
    name: 'Dart SDK',
    description: 'The language Flutter apps are written in. It comes with Flutter.',
    stack: 'flutter',
    detect: {
      kind: 'command',
      command: 'dart',
      args: ['--version'],
      fallbackPaths: ['~/develop/flutter/bin/cache/dart-sdk/bin/dart{exe}'],
    },
    recipes: everyOs({ kind: 'bundled', with: 'flutter' }),
    manualUrl: 'https://docs.flutter.dev/get-started/install',
  },
  {
    id: 'android-cmdline-tools',
    name: 'Android command-line tools',
    description: 'Downloads the rest of the Android SDK without needing Android Studio.',
    stack: 'flutter',
    dependsOn: ['jdk17'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'cmdline-tools' },
    recipes: everyOs({ kind: 'managed', installer: 'android-cmdline-tools' }),
    manualUrl: 'https://developer.android.com/studio#command-line-tools-only',
  },
  {
    id: 'android-licenses',
    name: 'Android SDK licenses',
    description: 'Accepting these lets the SDK tools install platforms and system images.',
    stack: 'flutter',
    dependsOn: ['android-cmdline-tools'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'licenses' },
    recipes: everyOs({ kind: 'managed', installer: 'android-licenses' }),
    consent: { title: 'Android SDK licenses', url: 'https://developer.android.com/studio/terms' },
  },
  {
    id: 'android-platform-tools',
    name: 'Android platform tools',
    description: 'Includes adb, which connects your computer to phones and emulators.',
    stack: 'flutter',
    dependsOn: ['android-licenses'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'platform-tools' },
    recipes: everyOs({
      kind: 'managed',
      installer: 'android-package',
      sdkPackage: 'platform-tools',
    }),
    manualUrl: 'https://developer.android.com/tools/releases/platform-tools',
  },
  {
    id: 'android-emulator',
    name: 'Android emulator',
    description: 'Runs a virtual Android phone on your computer for testing apps.',
    stack: 'flutter',
    dependsOn: ['android-licenses'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'emulator' },
    recipes: everyOs({ kind: 'managed', installer: 'android-package', sdkPackage: 'emulator' }),
    manualUrl: 'https://developer.android.com/studio/run/emulator',
  },
  {
    id: 'android-platform',
    name: 'Android 16 platform (API 36)',
    description: 'The Android version your apps are built against.',
    stack: 'flutter',
    dependsOn: ['android-licenses'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'platform' },
    recipes: everyOs({
      kind: 'managed',
      installer: 'android-package',
      sdkPackage: ANDROID_PLATFORM_PACKAGE,
    }),
    manualUrl: 'https://developer.android.com/studio#command-line-tools-only',
  },
  {
    id: 'android-system-image',
    name: 'Android emulator image',
    description: 'The Android system the emulator boots. About 1.5 GB to download.',
    stack: 'flutter',
    dependsOn: ['android-emulator', 'android-platform'],
    detect: { kind: 'resolver', id: 'android-sdk-piece', piece: 'system-image' },
    recipes: everyOs({
      kind: 'managed',
      installer: 'android-package',
      sdkPackage: ANDROID_SYSTEM_IMAGE_PACKAGE,
    }),
    manualUrl: 'https://developer.android.com/studio/run/managing-avds',
  },
  {
    id: 'android-studio',
    name: 'Android Studio',
    description: 'The full Android IDE. Not needed for the checklist above, but handy.',
    stack: 'flutter',
    optional: true,
    detect: {
      kind: 'paths',
      anyOf: [
        '%ProgramFiles%\\Android\\Android Studio\\bin\\studio64.exe',
        '%LOCALAPPDATA%\\Programs\\Android Studio\\bin\\studio64.exe',
        '/Applications/Android Studio.app',
        '/opt/android-studio/bin/studio.sh',
        '~/android-studio/bin/studio.sh',
      ],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'Google.AndroidStudio' }],
      darwin: [{ kind: 'brew-cask', cask: 'android-studio' }],
      linux: [{ kind: 'link', url: 'https://developer.android.com/studio' }],
    },
    manualUrl: 'https://developer.android.com/studio',
  },
  {
    id: 'xcode',
    name: 'Xcode',
    description: 'Apple IDE and simulators. Needed to build and run iOS apps.',
    stack: 'flutter',
    optional: true,
    os: ['darwin'],
    detect: {
      kind: 'command',
      command: 'xcodebuild',
      args: ['-version'],
      guard: { os: 'darwin', item: 'xcode-clt' },
    },
    recipes: {
      darwin: [{ kind: 'link', url: 'https://apps.apple.com/app/xcode/id497799835' }],
    },
  },
  {
    id: 'cocoapods',
    name: 'CocoaPods',
    description: 'Manages iOS dependencies. Flutter uses it when building for iPhone.',
    stack: 'flutter',
    optional: true,
    os: ['darwin'],
    detect: { kind: 'command', command: 'pod', args: ['--version'] },
    recipes: { darwin: [{ kind: 'brew', formula: 'cocoapods' }] },
  },

  // -------------------------------------------------------------------- Docker
  {
    id: 'wsl2',
    name: 'Windows Subsystem for Linux',
    description: 'The Linux layer Docker Desktop runs on in Windows.',
    stack: 'docker',
    os: ['win32'],
    minVersion: '2.1.5',
    restart: 'always',
    detect: { kind: 'resolver', id: 'wsl' },
    recipes: {
      win32: [
        {
          kind: 'terminal-only',
          command: 'wsl --install --no-distribution',
          note: 'Windows asks for permission, then needs a restart to finish.',
        },
      ],
    },
    manualUrl: 'https://learn.microsoft.com/windows/wsl/install',
  },
  {
    id: 'docker-desktop',
    name: 'Docker Desktop',
    nameByOs: { linux: 'Docker Engine' },
    description: 'Builds and runs containers on your computer.',
    stack: 'docker',
    minVersion: '24.0.0',
    restart: 'maybe',
    dependsOn: ['wsl2'],
    detect: {
      kind: 'command',
      command: 'docker',
      args: ['--version'],
      fallbackPaths: [
        '%ProgramFiles%\\Docker\\Docker\\resources\\bin\\docker{exe}',
        '/Applications/Docker.app/Contents/Resources/bin/docker',
      ],
    },
    recipes: {
      win32: [{ kind: 'winget', id: 'Docker.DockerDesktop' }],
      darwin: [{ kind: 'brew-cask', cask: 'docker-desktop', needsAdmin: true }],
      linux: [
        {
          kind: 'pkg',
          apt: ['docker.io'],
          dnf: ['docker'],
          pacman: ['docker'],
          note: 'Afterwards, add yourself to the docker group with: sudo usermod -aG docker $USER',
        },
      ],
    },
    consent: {
      title: 'Docker Subscription Service Agreement',
      url: 'https://www.docker.com/legal/docker-subscription-service-agreement/',
    },
    manualUrl: 'https://www.docker.com/products/docker-desktop/',
  },
  {
    id: 'docker-running',
    name: 'Docker is running',
    description: 'The Docker engine has to be started before containers can run.',
    stack: 'docker',
    dependsOn: ['docker-desktop'],
    detect: {
      kind: 'command',
      command: 'docker',
      args: ['info', '--format', '{{.ServerVersion}}'],
    },
    recipes: {
      win32: [{ kind: 'managed', installer: 'docker-launch' }],
      darwin: [{ kind: 'managed', installer: 'docker-launch' }],
      linux: [{ kind: 'terminal-only', command: 'sudo systemctl enable --now docker' }],
    },
  },

  // ---------------------------------------------------------------- Studio
  {
    id: 'ffmpeg',
    name: 'ffmpeg',
    description: 'Encodes video and audio. Studio renders every video with it.',
    stack: 'studio',
    minVersion: '6.0.0',
    detect: {
      kind: 'command',
      command: 'ffmpeg',
      args: ['-version'],
      firstLineOnly: true,
      // winget links its command-line apps here, a folder a fresh install has not put on PATH yet.
      fallbackPaths: ['%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffmpeg{exe}'],
    },
    recipes: {
      // The full build: it has the subtitle, x265 and VP9 encoders Studio offers.
      win32: [{ kind: 'winget', id: 'Gyan.FFmpeg' }],
      darwin: [{ kind: 'brew', formula: 'ffmpeg' }],
      linux: [
        {
          kind: 'pkg',
          apt: ['ffmpeg'],
          dnf: ['ffmpeg'],
          pacman: ['ffmpeg'],
          note: 'On Fedora the full ffmpeg comes from RPM Fusion; enable it first if dnf finds only ffmpeg-free.',
        },
      ],
    },
    manualUrl: 'https://ffmpeg.org/download.html',
  },
  {
    id: 'ffprobe',
    name: 'ffprobe',
    description: 'Reads the length, size and streams of a video. It comes with ffmpeg.',
    stack: 'studio',
    minVersion: '6.0.0',
    dependsOn: ['ffmpeg'],
    detect: {
      kind: 'command',
      command: 'ffprobe',
      args: ['-version'],
      firstLineOnly: true,
      fallbackPaths: ['%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffprobe{exe}'],
    },
    recipes: everyOs({ kind: 'bundled', with: 'ffmpeg' }),
    manualUrl: 'https://ffmpeg.org/download.html',
  },
  {
    id: 'studio-piper',
    name: 'Piper',
    description:
      'Speaks narration on this computer, offline, in Persian and English. Installed in its own Python inside Runova, nothing system-wide.',
    stack: 'studio',
    optional: true,
    detect: { kind: 'resolver', id: 'studio-tool', tool: 'piper' },
    recipes: everyOs({ kind: 'managed', installer: 'studio-python-env', target: 'piper' }),
    consent: {
      title: 'Piper is GPL-3.0 software, and so is espeak-ng, which it uses',
      url: 'https://github.com/OHF-Voice/piper1-gpl',
    },
  },
  {
    id: 'studio-piper-voices',
    name: 'Piper voices',
    description:
      'Three Persian voices, free for any use, and one English voice for non-commercial use (about 250 MB).',
    stack: 'studio',
    optional: true,
    dependsOn: ['studio-piper'],
    detect: { kind: 'resolver', id: 'studio-tool', tool: 'piper-voices' },
    recipes: everyOs({ kind: 'managed', installer: 'studio-model-files', target: 'piper-voices' }),
  },
  {
    id: 'studio-omnivoice',
    name: 'OmniVoice',
    description:
      'Clones your own voice from a few seconds of speech and narrates with it, on this computer. For non-commercial use only. Needs an NVIDIA graphics card or a Mac with Apple silicon to be quick.',
    stack: 'studio',
    optional: true,
    detect: { kind: 'resolver', id: 'studio-tool', tool: 'omnivoice' },
    recipes: everyOs({ kind: 'managed', installer: 'studio-python-env', target: 'omnivoice' }),
    consent: {
      title: 'OmniVoice model weights are CC BY-NC 4.0: non-commercial use only',
      url: 'https://huggingface.co/k2-fsa/OmniVoice',
    },
  },
  {
    id: 'studio-omnivoice-weights',
    name: 'OmniVoice model',
    description: 'The model OmniVoice speaks with (about 3.3 GB, downloaded so it can resume).',
    stack: 'studio',
    optional: true,
    dependsOn: ['studio-omnivoice'],
    detect: { kind: 'resolver', id: 'studio-tool', tool: 'omnivoice-weights' },
    recipes: everyOs({
      kind: 'managed',
      installer: 'studio-model-files',
      target: 'omnivoice-weights',
    }),
    consent: {
      title: 'OmniVoice model weights are CC BY-NC 4.0: non-commercial use only',
      url: 'https://huggingface.co/k2-fsa/OmniVoice',
    },
  },
];

const ITEMS_BY_ID: ReadonlyMap<string, DevItem> = new Map(DEV_ITEMS.map((item) => [item.id, item]));
const STACK_IDS: readonly string[] = DEV_STACKS.map((stack) => stack.id);

/** A Map lookup, so inherited keys like `constructor` can never read as an item. */
export function getDevItem(id: string): DevItem | undefined {
  return ITEMS_BY_ID.get(id);
}

/** The gate for every id that arrives over IPC: only catalog ids pass. */
export function isDevItemId(value: unknown): value is DevItemId {
  return typeof value === 'string' && ITEMS_BY_ID.has(value);
}

export function appliesToOs(item: DevItem, os: DevOs): boolean {
  return !item.os || item.os.includes(os);
}

/**
 * Dependencies that exist on this OS. Docker needs WSL on Windows and nothing on a Mac. The lookup
 * defaults to the catalog, and a caller working from its own list of items can pass that instead.
 */
export function applicableDependencies(
  item: DevItem,
  os: DevOs,
  lookup: (id: DevItemId) => DevItem | undefined = getDevItem,
): DevItemId[] {
  return (item.dependsOn ?? []).filter((id) => {
    const dependency = lookup(id);
    return dependency ? appliesToOs(dependency, os) : false;
  });
}

export function displayName(item: DevItem, os: DevOs): string {
  return item.nameByOs?.[os] ?? item.name;
}

/**
 * Essentials is always included and listed first, unknown ids are dropped, repeats are removed and
 * the rest follow catalog order. The settings file is user-editable, so anything can arrive here.
 */
export function normalizeDevSetupStacks(value: unknown): DevStackId[] {
  const picked = new Set<string>(['essentials']);
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && STACK_IDS.includes(entry)) picked.add(entry);
    }
  }
  return DEV_STACKS.filter((stack) => picked.has(stack.id)).map((stack) => stack.id);
}

/** The checklist for these stacks on this OS, in catalog order. */
export function itemsForStacks(stacks: readonly string[], os: DevOs): DevItem[] {
  const chosen = new Set<string>(normalizeDevSetupStacks(stacks));
  return DEV_ITEMS.filter((item) => chosen.has(item.stack) && appliesToOs(item, os));
}

export interface PathTemplateContext {
  os: DevOs;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

function lookupEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const exact = env[name]?.trim();
  if (exact) return exact;
  // Windows variable names are case-insensitive, but a copied environment object is not.
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key]?.trim() || undefined : undefined;
}

/**
 * Expands `%NAME%`, a leading `~` and the `{exe}` / `{script}` suffix markers. Returns null when a
 * variable is not set, so a fallback location is skipped instead of guessed at.
 */
export function expandPathTemplate(template: string, context: PathTemplateContext): string | null {
  let missing = false;
  const withEnv = template.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => {
    const value = lookupEnv(context.env, name);
    if (!value) missing = true;
    return value ?? '';
  });
  if (missing) return null;
  const withHome = /^~(?=[\\/]|$)/.test(withEnv) ? `${context.home}${withEnv.slice(1)}` : withEnv;
  return withHome
    .replaceAll('{exe}', context.os === 'win32' ? '.exe' : '')
    .replaceAll('{script}', context.os === 'win32' ? '.bat' : '');
}
