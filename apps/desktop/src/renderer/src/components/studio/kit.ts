/**
 * Everything Studio's screens take from the rest of AgentMate's renderer, in one place. Studio
 * code imports app UI from here only (studioBoundary.test.ts holds it to that), so if Studio ever
 * becomes an app of its own, this file is the one that gets reimplemented.
 */

export { toast } from 'sonner';
export { ErrorBoundary } from '@/components/ErrorBoundary';
export {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CircleCheck,
  Clapperboard,
  EllipsisVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Lock,
  Pencil,
  Plus,
  Redo,
  Trash2,
  TriangleAlert,
  Undo,
} from '@/components/icons';
export {
  CARD_GRID,
  CatalogCardShimmer,
  Chip,
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
export { Button } from '@/components/ui/button';
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
export { Skeleton } from '@/components/ui/skeleton';
export { Switch } from '@/components/ui/switch';
export { Textarea } from '@/components/ui/textarea';
export { SimpleTooltip } from '@/components/ui/tooltip';
export { queryKeys as appQueryKeys } from '@/lib/queryKeys';
export { persianTextProps } from '@/lib/rtl';
export { cn } from '@/lib/utils';
export { confirmDialog } from '@/stores/confirmStore';
export { usePageHeader } from '@/stores/pageHeaderStore';
