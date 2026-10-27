import { type Aspect, buildBriefRewriteRequest, STYLE_PRESETS, styleById } from '@runova/studio';
import { useId, useState } from 'react';
import {
  AgentPromptField,
  Button,
  Combobox,
  Label,
  type RunSettings,
  RunSettingsFields,
  SEGMENT_TRACK,
  segmentClass,
} from '../kit';
import { StylesDialog } from '../scenes/StylesDialog';

export interface BriefValue {
  brief: string;
  targetSeconds: number;
  styleId: string | null;
  run: RunSettings;
}

export const LENGTHS: { seconds: number; label: string }[] = [
  { seconds: 15, label: '15 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
  { seconds: 90, label: '1.5 min' },
  { seconds: 180, label: '3 min' },
];

const NO_STYLE = '__none__';

/**
 * What the AI needs to write a scenario: the brief in the user's own words, about how long, the
 * look, and which CLI, model and effort to run. Used by the editor's brief card and the New video
 * dialog, so both ask the same way.
 */
export function BriefFields({
  value,
  onChange,
  aspect,
  language,
  autoFocus,
  onSubmit,
}: {
  value: BriefValue;
  onChange: (next: BriefValue) => void;
  /** The video's format, to point out the styles made for it. */
  aspect: Aspect;
  /** The video's language, for the style examples. */
  language: string;
  autoFocus?: boolean;
  /** Ctrl+Enter in the brief, to start without reaching for the button. */
  onSubmit?: () => void;
}): React.JSX.Element {
  const id = useId();
  const [browsing, setBrowsing] = useState(false);
  const style = styleById(value.styleId);
  const styles = [
    { value: NO_STYLE, label: 'Let the AI choose', keywords: ['none', 'any'] },
    ...STYLE_PRESETS.map((s) => ({
      value: s.id,
      label:
        s.formats.includes(aspect) && s.formats.length < 4
          ? `${s.name} (made for ${aspect})`
          : s.name,
      keywords: [s.summary],
    })),
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-brief`}>What is the video about?</Label>
        {/* The same box as Ask AI elsewhere: Persian, dictation in Persian or English, a
            translation to English, and an AI rewrite of a rough note into a brief. */}
        <AgentPromptField
          id={`${id}-brief`}
          value={value.brief}
          onChange={(brief) => onChange({ ...value, brief })}
          buildRequest={(note) => buildBriefRewriteRequest(note, language)}
          rewriteHint="The AI turns your note into a clear brief"
          ariaLabel="What is the video about?"
          autoFocus={autoFocus}
          maxLength={100_000}
          minHeight={120}
          maxHeight={320}
          textClassName="text-sm leading-6"
          placeholder="Who it is for, what they should feel or do, and anything it must say. Paste notes, a product description or a draft script if you have one."
          submitOn="mod-enter"
          onSubmit={() => onSubmit?.()}
        />
      </div>
      <div className="grid gap-x-3 gap-y-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label id={`${id}-length`} className="block">
            Length
          </Label>
          <div className={SEGMENT_TRACK} role="radiogroup" aria-labelledby={`${id}-length`}>
            {LENGTHS.map((length) => (
              <button
                key={length.seconds}
                type="button"
                role="radio"
                aria-checked={value.targetSeconds === length.seconds}
                className={segmentClass(value.targetSeconds === length.seconds)}
                onClick={() => onChange({ ...value, targetSeconds: length.seconds })}
              >
                {length.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="block">Style</Label>
          <div className="flex gap-2">
            <Combobox
              ariaLabel="Style"
              className="min-w-0 flex-1"
              options={styles}
              value={value.styleId ?? NO_STYLE}
              onChange={(next) => onChange({ ...value, styleId: next === NO_STYLE ? null : next })}
            />
            <Button type="button" variant="outline" onClick={() => setBrowsing(true)}>
              See styles
            </Button>
          </div>
          <StylesDialog
            open={browsing}
            onOpenChange={setBrowsing}
            value={value.styleId}
            aspect={aspect}
            language={language}
            onPick={(styleId) => onChange({ ...value, styleId })}
          />
        </div>
      </div>
      {style && <p className="text-xs text-muted-foreground">{style.summary}</p>}
      <RunSettingsFields
        labels="form"
        value={value.run}
        onChange={(run) => onChange({ ...value, run })}
      />
    </div>
  );
}
