import { type Aspect, DESIGN_SIZES, STYLE_PRESETS, styleById } from '@runova/studio';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { studioScenesClient } from '../client';
import { errorMessage } from '../format';
import {
  Button,
  Chip,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadFailure,
  Skeleton,
} from '../kit';
import { studioKeys } from '../queryKeys';
import { ScenePreview } from './ScenePreview';

export interface StylesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The style picked so far, shown first. */
  value: string | null;
  aspect: Aspect;
  language: string;
  onPick: (styleId: string) => void;
}

const PREVIEW_SECONDS = 6;

/**
 * The fifteen styles, each with its palette and its own reference scene playing in the video's
 * language and format, so the user picks a look by seeing it. One scene plays at a time.
 */
export function StylesDialog({
  open,
  onOpenChange,
  value,
  aspect,
  language,
  onPick,
}: StylesDialogProps): React.JSX.Element {
  const [selected, setSelected] = useState(value ?? STYLE_PRESETS[0]?.id ?? '');
  useEffect(() => {
    if (open) setSelected(value ?? STYLE_PRESETS[0]?.id ?? '');
  }, [open, value]);
  const style = styleById(selected);
  const size = DESIGN_SIZES[aspect];
  const reference = useQuery({
    queryKey: studioKeys.styleReference(selected, aspect, language),
    queryFn: () => studioScenesClient().styleReference({ styleId: selected, aspect, language }),
    enabled: open && !!selected,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Styles</DialogTitle>
          <DialogDescription>
            Each style comes with a short example scene. The AI follows the style you pick when it
            writes and animates the video.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_22rem]">
          {/* The margin and padding cancel out, leaving room for a card's focus ring. */}
          <ul
            className="-m-1 grid max-h-[60vh] grid-cols-2 gap-2 overflow-y-auto p-1 lg:grid-cols-3"
            aria-label="Styles"
          >
            {STYLE_PRESETS.map((preset) => (
              <li key={preset.id} className="flex">
                <button
                  type="button"
                  aria-pressed={preset.id === selected}
                  className={cn(
                    'flex w-full flex-col items-start rounded-xl p-2.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    preset.id === selected
                      ? 'bg-primary/10 ring-primary/40'
                      : 'ring-foreground/10 hover:bg-foreground/[0.04]',
                  )}
                  onClick={() => setSelected(preset.id)}
                >
                  <span className="flex gap-1" aria-hidden>
                    {preset.palette.map((color) => (
                      <i
                        key={color}
                        className="h-3 w-5 rounded-sm ring-1 ring-inset ring-foreground/20"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className="mt-1.5 block text-sm font-medium">{preset.name}</span>
                  <span className="line-clamp-2 text-[11px] text-muted-foreground">
                    {preset.summary}
                  </span>
                  {preset.formats.includes(aspect) && preset.formats.length < 4 && (
                    <span className="mt-auto pt-1">
                      <Chip tone="primary">Made for {aspect}</Chip>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <section className="space-y-2" aria-label="Example">
            {reference.isPending && (
              <Skeleton
                className="w-full"
                style={{ aspectRatio: `${size.width} / ${size.height}` }}
              />
            )}
            {reference.error && (
              <LoadFailure
                message={`The example did not load. ${errorMessage(reference.error)}`}
                retry={() => void reference.refetch()}
              />
            )}
            {reference.data && style && (
              <ScenePreview
                key={reference.data.url}
                url={reference.data.url}
                width={size.width}
                height={size.height}
                duration={PREVIEW_SECONDS}
                autoPlay
                label={`${style.name} example`}
              />
            )}
            {style && (
              <div className="space-y-1 text-xs">
                <p className="text-sm font-semibold">{style.name}</p>
                <p className="text-muted-foreground">{style.motion}</p>
                <p>
                  <span className="font-medium">Do:</span> {style.dos.join('; ')}.
                </p>
                <p>
                  <span className="font-medium">Avoid:</span> {style.donts.join('; ')}.
                </p>
              </div>
            )}
          </section>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!style}
            onClick={() => {
              onPick(selected);
              onOpenChange(false);
            }}
          >
            Use {style?.name ?? 'this style'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
