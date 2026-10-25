import type { DevItemId, DevRecipe, InstallIntent } from '@agentmat/core';
import type { RunHooks, RunResult } from './packageManagerRunner';

/**
 * Which of the app's own installers a `managed` recipe means. The Android package ids come from
 * the catalog (through `androidPackages`), so nothing that reaches sdkmanager was ever typed by
 * the renderer.
 */

export interface ManagedRunners {
  flutter: {
    run: (hooks: RunHooks) => Promise<RunResult>;
    /** `foundAt` is where the Flutter to update was found. */
    update: (hooks: RunHooks, foundAt: string | null) => Promise<RunResult>;
  };
  android: {
    runCmdlineTools: (hooks: RunHooks) => Promise<RunResult>;
    runLicenses: (hooks: RunHooks) => Promise<RunResult>;
    runPackage: (sdkPackage: string, hooks: RunHooks) => Promise<RunResult>;
  };
  dockerLaunch: { run: (hooks: RunHooks) => Promise<RunResult> };
  /** The sdkmanager package for each Android item, for this CPU. */
  androidPackages: Readonly<Record<DevItemId, string>>;
}

/** What the step is for, and where the tool is when it already is. */
export interface ManagedRunContext {
  intent: InstallIntent;
  path: string | null;
}

const INSTALL: ManagedRunContext = { intent: 'install', path: null };

function cannotUpdate(): Promise<RunResult> {
  return Promise.resolve({
    ok: false,
    code: null,
    cancelled: false,
    message: 'This step cannot be updated.',
  });
}

export function runManagedRecipe(
  itemId: DevItemId,
  recipe: Extract<DevRecipe, { kind: 'managed' }>,
  hooks: RunHooks,
  runners: ManagedRunners,
  context: ManagedRunContext = INSTALL,
): Promise<RunResult> {
  const updating = context.intent === 'update';
  switch (recipe.installer) {
    case 'flutter-archive':
      return updating ? runners.flutter.update(hooks, context.path) : runners.flutter.run(hooks);
    case 'android-cmdline-tools':
      // The tools cannot replace themselves while they run, so they are never offered an update.
      return updating ? cannotUpdate() : runners.android.runCmdlineTools(hooks);
    case 'android-licenses':
      return updating ? cannotUpdate() : runners.android.runLicenses(hooks);
    case 'android-package': {
      const sdkPackage = runners.androidPackages[itemId];
      if (!sdkPackage) {
        return Promise.resolve({
          ok: false,
          code: null,
          cancelled: false,
          message: 'There is no Android package set for that item.',
        });
      }
      // Asking sdkmanager for a package that is installed brings it to the newest revision.
      return runners.android.runPackage(sdkPackage, hooks);
    }
    case 'docker-launch':
      return updating ? cannotUpdate() : runners.dockerLaunch.run(hooks);
  }
}
