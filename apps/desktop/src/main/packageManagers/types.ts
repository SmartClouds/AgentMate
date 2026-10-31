import type {
  PackageManagerEcosystem,
  PackageManagerSection,
  PackageUpdateRequest,
  PackageUpdateResult,
  RuntimeUpdateRequest,
  RuntimeUpdateResult,
} from '../../shared/apiTypes';
import type { RuntimeUpdateDeps } from './runtimeUpdate';

export interface UpdateProgressTick {
  packageName: string;
  status: 'running' | 'done' | 'error';
  message?: string;
  completed: number;
  total: number;
}

export interface PackageManagerAdapter {
  ecosystem: PackageManagerEcosystem;
  /** Filesystem-only check, must not spawn a CLI. */
  detect(folderPath: string): Promise<boolean>;
  /** One section per package manager the folder uses (Node can mix several). */
  listPackages(folderPath: string): Promise<PackageManagerSection[]>;
  updatePackages(
    folderPath: string,
    updates: PackageUpdateRequest[],
    onProgress: (tick: UpdateProgressTick) => void,
  ): Promise<PackageUpdateResult>;
  /** Moves one runtime target (an SDK constraint, a target framework, a pin) to its latest version. */
  updateRuntime(
    folderPath: string,
    request: RuntimeUpdateRequest,
    deps: RuntimeUpdateDeps,
  ): Promise<RuntimeUpdateResult>;
}
