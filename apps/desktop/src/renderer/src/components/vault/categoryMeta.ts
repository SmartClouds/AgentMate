import {
  VAULT_CATEGORY_COLORS,
  VAULT_CATEGORY_ICONS,
  type VaultCategoryColor,
  type VaultCategoryIcon,
} from '@runova/core';
import {
  Bank,
  Briefcase,
  Cloud,
  Code,
  Folder,
  Gamepad,
  Globe,
  GraduationCap,
  Heart,
  House,
  type IconProps,
  Server,
  ShoppingCart,
} from '@/components/icons';

export interface CategoryColorMeta {
  label: string;
  /** The round swatch in the color picker and the dot beside an entry. */
  swatch: string;
  /** The rounded icon tile: a soft tint, the strong color for the glyph, and a hairline ring. */
  tile: string;
  /** A tinted wash for a drop target or an active chip. */
  wash: string;
}

// Written out in full so Tailwind finds every class when it scans this file.
export const CATEGORY_COLORS: Record<VaultCategoryColor, CategoryColorMeta> = {
  slate: {
    label: 'Slate',
    swatch: 'bg-slate-500',
    tile: 'bg-slate-500/15 text-slate-600 ring-slate-500/25 dark:text-slate-300',
    wash: 'bg-slate-500/10 ring-slate-500/40',
  },
  red: {
    label: 'Red',
    swatch: 'bg-red-500',
    tile: 'bg-red-500/15 text-red-600 ring-red-500/25 dark:text-red-400',
    wash: 'bg-red-500/10 ring-red-500/40',
  },
  orange: {
    label: 'Orange',
    swatch: 'bg-orange-500',
    tile: 'bg-orange-500/15 text-orange-600 ring-orange-500/25 dark:text-orange-400',
    wash: 'bg-orange-500/10 ring-orange-500/40',
  },
  amber: {
    label: 'Amber',
    swatch: 'bg-amber-400',
    tile: 'bg-amber-400/20 text-amber-600 ring-amber-500/25 dark:text-amber-400',
    wash: 'bg-amber-400/10 ring-amber-500/40',
  },
  green: {
    label: 'Green',
    swatch: 'bg-emerald-500',
    tile: 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/25 dark:text-emerald-400',
    wash: 'bg-emerald-500/10 ring-emerald-500/40',
  },
  teal: {
    label: 'Teal',
    swatch: 'bg-teal-500',
    tile: 'bg-teal-500/15 text-teal-600 ring-teal-500/25 dark:text-teal-400',
    wash: 'bg-teal-500/10 ring-teal-500/40',
  },
  blue: {
    label: 'Blue',
    swatch: 'bg-sky-500',
    tile: 'bg-sky-500/15 text-sky-600 ring-sky-500/25 dark:text-sky-400',
    wash: 'bg-sky-500/10 ring-sky-500/40',
  },
  violet: {
    label: 'Violet',
    swatch: 'bg-violet-500',
    tile: 'bg-violet-500/15 text-violet-600 ring-violet-500/25 dark:text-violet-400',
    wash: 'bg-violet-500/10 ring-violet-500/40',
  },
  pink: {
    label: 'Pink',
    swatch: 'bg-pink-500',
    tile: 'bg-pink-500/15 text-pink-600 ring-pink-500/25 dark:text-pink-400',
    wash: 'bg-pink-500/10 ring-pink-500/40',
  },
};

export const CATEGORY_ICONS: Record<
  VaultCategoryIcon,
  { label: string; Icon: React.ComponentType<IconProps> }
> = {
  folder: { label: 'Folder', Icon: Folder },
  briefcase: { label: 'Work', Icon: Briefcase },
  home: { label: 'Home', Icon: House },
  code: { label: 'Code', Icon: Code },
  server: { label: 'Servers', Icon: Server },
  cloud: { label: 'Cloud', Icon: Cloud },
  bank: { label: 'Finance', Icon: Bank },
  cart: { label: 'Shopping', Icon: ShoppingCart },
  gamepad: { label: 'Games', Icon: Gamepad },
  heart: { label: 'Personal', Icon: Heart },
  school: { label: 'School', Icon: GraduationCap },
  globe: { label: 'Web', Icon: Globe },
};

export const CATEGORY_COLOR_ORDER = VAULT_CATEGORY_COLORS;
export const CATEGORY_ICON_ORDER = VAULT_CATEGORY_ICONS;
