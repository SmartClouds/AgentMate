import type { DevStackId } from '@runova/core';
import { Clapperboard, Code, Docker, Package, Smartphone } from '@/components/icons';

/** One icon per stack, shared by the chips and the checklist headings so they match. */
export const STACK_ICONS: Record<DevStackId, React.ComponentType<{ className?: string }>> = {
  essentials: Package,
  dotnet: Code,
  flutter: Smartphone,
  docker: Docker,
  studio: Clapperboard,
};
