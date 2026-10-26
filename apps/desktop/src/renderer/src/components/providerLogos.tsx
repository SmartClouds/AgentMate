import { getUsageProvider } from '@runova/core';
import { siClaude, siCursor, siGooglegemini, siMeta, siOllama } from 'simple-icons';
import { openaiMark, xaiMark } from '@/components/brandMarks';
import { cn } from '@/lib/utils';

interface BrandLogo {
  path: string;
  color: string;
  invertOnDark?: boolean;
  /** Only when the mark isn't drawn on the simple-icons 24x24 grid. */
  viewBox?: string;
}

// Providers with a brand glyph get it here. Everyone else uses a logo file below, and
// anything with neither falls back to a colored monogram driven by the registry's accentColor.
const BRAND_LOGOS: Record<string, BrandLogo> = {
  'claude-code': { path: siClaude.path, color: `#${siClaude.hex}` },
  cursor: { path: siCursor.path, color: `#${siCursor.hex}`, invertOnDark: true },
  gemini: { path: siGooglegemini.path, color: `#${siGooglegemini.hex}` },
  // Gemini CLI shares the Gemini mark under its own provider id.
  'gemini-cli': { path: siGooglegemini.path, color: `#${siGooglegemini.hex}` },
  ollama: { path: siOllama.path, color: `#${siOllama.hex}`, invertOnDark: true },
  codex: { ...openaiMark, invertOnDark: true },
  openai: { ...openaiMark, invertOnDark: true },
  grok: { ...xaiMark, invertOnDark: true },
  // The same Meta mark the Muse Code row uses in the CLI list.
  meta: { path: siMeta.path, color: `#${siMeta.hex}` },
};

// Logo files in assets/provider-logos, named by registry id. A `<id>-dark` file is shown
// in dark mode instead of the light one.
const LOGO_FILES = import.meta.glob<string>('../assets/provider-logos/*.{svg,png}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const LOGO_URLS = new Map(
  Object.entries(LOGO_FILES).map(([path, url]) => [
    path.replace(/^.*\//, '').replace(/\.(svg|png)$/, ''),
    url,
  ]),
);

// Solid black marks with no background. They disappear on a dark page, so they flip there.
const INVERT_ON_DARK = new Set(['augment', 'clinepass', 'copilot', 'devin', 'neuralwatt', 'zed']);

export interface ProviderLogoProps {
  providerId: string;
  className?: string;
}

export function ProviderLogo({ providerId, className }: ProviderLogoProps): React.JSX.Element {
  const brand = BRAND_LOGOS[providerId];
  if (brand) {
    return (
      <svg
        role="img"
        viewBox={brand.viewBox ?? '0 0 24 24'}
        fill={brand.color}
        className={cn('shrink-0', brand.invertOnDark && 'dark:invert', className)}
      >
        <path d={brand.path} />
      </svg>
    );
  }

  const src = LOGO_URLS.get(providerId);
  if (src) {
    const darkSrc = LOGO_URLS.get(`${providerId}-dark`);
    if (darkSrc) {
      return (
        <>
          <img src={src} alt="" className={cn('shrink-0 object-contain dark:hidden', className)} />
          <img
            src={darkSrc}
            alt=""
            className={cn('hidden shrink-0 object-contain dark:block', className)}
          />
        </>
      );
    }
    return (
      <img
        src={src}
        alt=""
        className={cn(
          'shrink-0 object-contain',
          INVERT_ON_DARK.has(providerId) && 'dark:invert',
          className,
        )}
      />
    );
  }

  const def = getUsageProvider(providerId);
  const color = def?.accentColor ?? '#888888';
  const letter =
    (def?.name ?? '?')
      .replace(/[^A-Za-z0-9]/g, '')
      .charAt(0)
      .toUpperCase() || '?';
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md text-[10px] font-bold leading-none text-white',
        className,
      )}
      style={{ backgroundColor: color }}
    >
      {letter}
    </span>
  );
}
