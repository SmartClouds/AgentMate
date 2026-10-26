/**
 * Everything Studio's screens take from the rest of AgentMate's renderer, in one place. Studio
 * code imports app UI from here only (studioBoundary.test.ts holds it to that), so if Studio ever
 * becomes an app of its own, this file is the one that gets reimplemented.
 */

export { getCliDefinition, launchPickLabel } from '@agentmat/core';
export { toast } from 'sonner';
export { type RunSettings, RunSettingsFields } from '@/components/cli/RunSettingsFields';
export { ErrorBoundary } from '@/components/ErrorBoundary';
export {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bookmark,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Clapperboard,
  Code,
  EllipsisVertical,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  ImageIcon,
  Key,
  Lock,
  Microphone,
  Pause,
  Pencil,
  Play,
  Plus,
  Redo,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Spinner,
  StopCircle,
  Trash2,
  TriangleAlert,
  Undo,
  Video,
  Wand2,
  Wrench,
  X,
} from '@/components/icons';

import { lazy } from 'react';

/** Monaco is large, so the code view loads it only when it opens. */
export const MonacoEditor = lazy(() =>
  import('@/components/editor/MonacoEditor').then((m) => ({ default: m.MonacoEditor })),
);
/** Monaco's side-by-side diff, for comparing two revisions of a scene's code or two AI runs. */
export const MonacoDiffEditor = lazy(() =>
  import('@/components/editor/MonacoDiffEditor').then((m) => ({ default: m.MonacoDiffEditor })),
);
export {
  CARD_GRID,
  CatalogCardShimmer,
  Chip,
  type ChipTone,
  EmptyState,
  GLASS_CARD,
  GLASS_PANEL,
  LoadFailure,
  Notice,
  SECTION_HEADING,
  SECTION_WELL,
  SEGMENT_TRACK,
  segmentClass,
  TOOLBAR,
} from '@/components/pageKit';
export { SshVaultUnlockDialog as VaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
export { Button } from '@/components/ui/button';
export { Checkbox } from '@/components/ui/checkbox';
export { Combobox, type ComboboxOption } from '@/components/ui/combobox';
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
export { Input } from '@/components/ui/input';
export { Label } from '@/components/ui/label';
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
export { SecretInput } from '@/components/ui/secret-input';
export { Skeleton } from '@/components/ui/skeleton';
export { Switch } from '@/components/ui/switch';
export { Textarea } from '@/components/ui/textarea';
export { SimpleTooltip } from '@/components/ui/tooltip';
export { queryKeys as appQueryKeys } from '@/lib/queryKeys';
export { persianTextProps } from '@/lib/rtl';
export { cn } from '@/lib/utils';
export { confirmDialog } from '@/stores/confirmStore';
export { usePageHeader } from '@/stores/pageHeaderStore';
