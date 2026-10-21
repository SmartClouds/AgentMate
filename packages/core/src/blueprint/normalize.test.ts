import { describe, expect, it } from 'vitest';
import { BLUEPRINT_STEP_IDS, type ProjectBlueprint } from '../types/index.js';
import {
  blueprintFilledSections,
  blueprintTextHash,
  createBlankBlueprint,
  DEFAULT_BLUEPRINT_DOCS_FOLDER,
  normalizeBlueprintAttachment,
  normalizeBlueprintPreset,
  normalizeDocsFolder,
  withBlueprintDefaults,
} from './normalize.js';

/**
 * blueprints.json is written by whichever build ran last and can be hand-edited, so
 * everything downstream is allowed to assume one section per step, in order. The docs
 * folder and the attachment names are the two fields that become paths, so both are
 * refused rather than repaired when they are not what the app itself would have written.
 */

/** A legacy or partial record, cast once at the boundary the way the reader does. */
function asBlueprint(value: unknown): ProjectBlueprint {
  return value as ProjectBlueprint;
}

describe('normalizeDocsFolder', () => {
  it('keeps a plain relative folder, and a nested one in posix form', () => {
    expect(normalizeDocsFolder('docs')).toBe('docs');
    expect(normalizeDocsFolder('docs/plan')).toBe('docs/plan');
    expect(normalizeDocsFolder(String.raw`docs\plan`)).toBe('docs/plan');
  });

  it('collapses repeated separators, trims segments and drops "."', () => {
    expect(normalizeDocsFolder('//docs///plan//')).toBe('docs/plan');
    expect(normalizeDocsFolder(' docs / plan ')).toBe('docs/plan');
    expect(normalizeDocsFolder('./docs')).toBe('docs');
  });

  it('refuses a path that climbs out or names a drive', () => {
    // This folder ends up inside a prompt an agent acts on, so it is refused rather
    // than sanitized into some other folder the user did not ask for.
    for (const value of ['../outside', 'docs/../..', 'C:/docs', String.raw`C:\docs`]) {
      expect(normalizeDocsFolder(value), value).toBe(DEFAULT_BLUEPRINT_DOCS_FOLDER);
    }
  });

  it('falls back for anything that is not a usable string', () => {
    for (const value of ['', '   ', '///', '.', undefined, null, 42, {}]) {
      expect(normalizeDocsFolder(value), String(value)).toBe(DEFAULT_BLUEPRINT_DOCS_FOLDER);
    }
  });

  it('is idempotent', () => {
    for (const value of ['docs', 'docs/plan', '../nope']) {
      expect(normalizeDocsFolder(normalizeDocsFolder(value)), value).toBe(
        normalizeDocsFolder(value),
      );
    }
  });
});

describe('blueprintTextHash', () => {
  it('is stable for the same text and differs for different text', () => {
    expect(blueprintTextHash('hello')).toBe(blueprintTextHash('hello'));
    expect(blueprintTextHash('hello')).not.toBe(blueprintTextHash('hello '));
  });

  it("returns a base36 string, never a negative sign that would break a JSON key's shape", () => {
    for (const text of ['', 'a', 'x'.repeat(5000), 'سلام دنیا', '😀 emoji']) {
      expect(blueprintTextHash(text), text.slice(0, 12)).toMatch(/^[0-9a-z]+$/);
    }
  });

  it('handles an empty string without throwing', () => {
    expect(blueprintTextHash('')).toBe((5381 >>> 0).toString(36));
  });
});

describe('normalizeBlueprintAttachment', () => {
  const valid = {
    id: 'att-1',
    fileName: 'shot-1.png',
    displayName: '  Login screen  ',
    mime: 'image/png',
    size: 1234,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps a well-formed record and trims the display name', () => {
    expect(normalizeBlueprintAttachment(valid)).toEqual({ ...valid, displayName: 'Login screen' });
  });

  it('refuses a file name that is not a plain generated name', () => {
    // The name becomes a path under the app data folder, so anything else is dropped
    // rather than sanitized into a different file.
    for (const fileName of [
      '../escape.png',
      'sub/dir.png',
      String.raw`sub\dir.png`,
      'C:/abs.png',
      'with space.png',
      'quote".png',
      '',
    ]) {
      expect(normalizeBlueprintAttachment({ ...valid, fileName }), fileName).toBeNull();
    }
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'shot.png', 42, []]) {
      expect(normalizeBlueprintAttachment(value), String(value)).toBeNull();
    }
  });

  it('falls back to the file name for a missing id or display name', () => {
    const record = normalizeBlueprintAttachment({ fileName: 'shot.png' });
    expect(record?.id).toBe('shot.png');
    expect(record?.displayName).toBe('shot.png');
    expect(record?.mime).toBe('application/octet-stream');
    expect(record?.size).toBe(0);
  });

  it('clamps a nonsensical size rather than passing it to the UI', () => {
    expect(normalizeBlueprintAttachment({ ...valid, size: -5 })?.size).toBe(0);
    expect(normalizeBlueprintAttachment({ ...valid, size: Number.NaN })?.size).toBe(0);
    expect(normalizeBlueprintAttachment({ ...valid, size: Number.POSITIVE_INFINITY })?.size).toBe(
      0,
    );
    expect(normalizeBlueprintAttachment({ ...valid, size: '1234' })?.size).toBe(0);
  });

  it('stamps a created time when the record has none', () => {
    const record = normalizeBlueprintAttachment({ fileName: 'shot.png' });
    expect(Number.isNaN(Date.parse(record?.createdAt ?? ''))).toBe(false);
  });
});

describe('withBlueprintDefaults', () => {
  it('produces one section per step, in wizard order, for an empty record', () => {
    const blueprint = withBlueprintDefaults(asBlueprint({}));
    expect(blueprint.sections.map((section) => section.stepId)).toEqual([...BLUEPRINT_STEP_IDS]);
    expect(blueprint.id).toBe('');
    expect(blueprint.projectId).toBe('');
    expect(blueprint.docsFolder).toBe(DEFAULT_BLUEPRINT_DOCS_FOLDER);
    expect(blueprint.finalPrompt).toBe('');
    expect(blueprint.finalPromptUpdatedAt).toBeNull();
    // Asking first is the safer default for an agent about to write a folder of files.
    expect(blueprint.confirmBeforeWriting).toBe(true);
  });

  it('keeps the text and flags of a partial record', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        id: 'bp-1',
        projectId: 'proj-1',
        sections: [{ stepId: 'backend', text: 'Fastify + Postgres', includeInAgentFile: true }],
      }),
    );
    const backend = blueprint.sections.find((section) => section.stepId === 'backend');
    expect(backend?.text).toBe('Fastify + Postgres');
    expect(backend?.includeInAgentFile).toBe(true);
    const idea = blueprint.sections.find((section) => section.stepId === 'idea');
    expect(idea?.text).toBe('');
    expect(idea?.includeInAgentFile).toBe(false);
  });

  it('reorders sections the file happened to store out of order', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        sections: [
          { stepId: 'quality', text: 'q' },
          { stepId: 'idea', text: 'i' },
        ],
      }),
    );
    expect(blueprint.sections.map((section) => section.stepId)).toEqual([...BLUEPRINT_STEP_IDS]);
    expect(blueprint.sections[0].text).toBe('i');
  });

  it('drops sections on an unknown step and keeps the first of a duplicate pair', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        sections: [
          { stepId: 'idea', text: 'first' },
          { stepId: 'idea', text: 'second' },
          { stepId: 'not-a-step', text: 'nope' },
          null,
          'nope',
        ],
      }),
    );
    expect(blueprint.sections).toHaveLength(BLUEPRINT_STEP_IDS.length);
    expect(blueprint.sections[0].text).toBe('first');
  });

  it('tolerates sections that are not an array at all', () => {
    expect(withBlueprintDefaults(asBlueprint({ sections: 'oops' })).sections).toHaveLength(
      BLUEPRINT_STEP_IDS.length,
    );
  });

  it('drops a translation hash that has no translation behind it', () => {
    // Keeping the hash would make the next generate skip a translation it never has.
    const blueprint = withBlueprintDefaults(
      asBlueprint({ sections: [{ stepId: 'idea', text: 'x', textEnHash: 'abc' }] }),
    );
    expect(blueprint.sections[0].textEn).toBeNull();
    expect(blueprint.sections[0].textEnHash).toBeNull();
  });

  it('keeps a hash that does have a translation', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        sections: [{ stepId: 'idea', text: 'x', textEn: 'x in english', textEnHash: 'abc' }],
      }),
    );
    expect(blueprint.sections[0].textEn).toBe('x in english');
    expect(blueprint.sections[0].textEnHash).toBe('abc');
  });

  it('filters the attachments of a section through the attachment normalizer', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        sections: [
          {
            stepId: 'idea',
            text: 'x',
            attachments: [{ fileName: 'ok.png' }, { fileName: '../bad.png' }, 'nope'],
          },
        ],
      }),
    );
    expect(blueprint.sections[0].attachments.map((a) => a.fileName)).toEqual(['ok.png']);
  });

  it('respects an explicit false on confirmBeforeWriting but nothing weaker', () => {
    expect(
      withBlueprintDefaults(asBlueprint({ confirmBeforeWriting: false })).confirmBeforeWriting,
    ).toBe(false);
    expect(
      withBlueprintDefaults(asBlueprint({ confirmBeforeWriting: 0 })).confirmBeforeWriting,
    ).toBe(true);
  });

  it('leaves the Relay split off with the default budget when a record has none', () => {
    expect(withBlueprintDefaults(asBlueprint({})).relay).toEqual({
      enabled: false,
      budgetTokens: 200_000,
    });
  });

  it('keeps a saved Relay split and budget, and drops a budget it cannot use', () => {
    expect(
      withBlueprintDefaults(asBlueprint({ relay: { enabled: true, budgetTokens: 400_000 } })).relay,
    ).toEqual({ enabled: true, budgetTokens: 400_000 });
    expect(
      withBlueprintDefaults(asBlueprint({ relay: { enabled: 'yes', budgetTokens: -1 } })).relay,
    ).toEqual({ enabled: false, budgetTokens: 200_000 });
    expect(
      withBlueprintDefaults(asBlueprint({ relay: { enabled: true, budgetTokens: 900 } })).relay,
    ).toEqual({ enabled: true, budgetTokens: 200_000 });
  });

  it('dates a record with no timestamps from one moment, not two', () => {
    const blueprint = withBlueprintDefaults(asBlueprint({}));
    expect(blueprint.updatedAt).toBe(blueprint.createdAt);
    for (const section of blueprint.sections) {
      expect(section.updatedAt).toBe(blueprint.createdAt);
    }
  });

  it('is idempotent, since the record is normalized on every read', () => {
    const once = withBlueprintDefaults(
      asBlueprint({
        id: 'bp-1',
        projectId: 'proj-1',
        docsFolder: 'docs/plan',
        sections: [{ stepId: 'idea', text: 'x', updatedAt: '2026-01-01T00:00:00.000Z' }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect(withBlueprintDefaults(once)).toEqual(once);
  });
});

describe('createBlankBlueprint', () => {
  it('matches what the normalizer would produce for the same ids', () => {
    const blank = createBlankBlueprint('bp-1', 'proj-1');
    expect(blank.id).toBe('bp-1');
    expect(blank.projectId).toBe('proj-1');
    expect(blank.sections.map((section) => section.stepId)).toEqual([...BLUEPRINT_STEP_IDS]);
    expect(withBlueprintDefaults(blank)).toEqual(blank);
  });

  it('starts every section empty', () => {
    for (const section of createBlankBlueprint('bp-1', 'proj-1').sections) {
      expect(section.text, section.stepId).toBe('');
      expect(section.textEn, section.stepId).toBeNull();
      expect(section.attachments, section.stepId).toEqual([]);
      expect(section.includeInAgentFile, section.stepId).toBe(false);
    }
  });
});

describe('normalizeBlueprintPreset', () => {
  const valid = {
    id: 'preset-1',
    stepId: 'backend',
    label: 'Node + Fastify',
    text: 'Node.js with Fastify',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps a well-formed preset', () => {
    expect(normalizeBlueprintPreset(valid)).toEqual(valid);
  });

  it('refuses a preset with no id, an unknown step, no label or no text', () => {
    expect(normalizeBlueprintPreset({ ...valid, id: '' })).toBeNull();
    expect(normalizeBlueprintPreset({ ...valid, stepId: 'not-a-step' })).toBeNull();
    expect(normalizeBlueprintPreset({ ...valid, label: '   ' })).toBeNull();
    // Whitespace is not content, and an empty chip would insert nothing.
    expect(normalizeBlueprintPreset({ ...valid, text: '   ' })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, undefined, 'preset', 42, []]) {
      expect(normalizeBlueprintPreset(value), String(value)).toBeNull();
    }
  });

  it('trims and caps the label, which is chip text', () => {
    const preset = normalizeBlueprintPreset({ ...valid, label: `  ${'x'.repeat(100)}  ` });
    expect(preset?.label).toHaveLength(60);
  });

  it('keeps the text untrimmed, since it is appended to a box the user edits', () => {
    expect(normalizeBlueprintPreset({ ...valid, text: '  padded  ' })?.text).toBe('  padded  ');
  });

  it('stamps a created time when the record has none', () => {
    const preset = normalizeBlueprintPreset({ ...valid, createdAt: undefined });
    expect(Number.isNaN(Date.parse(preset?.createdAt ?? ''))).toBe(false);
  });
});

describe('blueprintFilledSections', () => {
  it('counts only sections with real content', () => {
    const blueprint = withBlueprintDefaults(
      asBlueprint({
        sections: [
          { stepId: 'idea', text: 'an idea' },
          { stepId: 'backend', text: '   ' },
          { stepId: 'frontend', text: '\n\n' },
        ],
      }),
    );
    expect(blueprintFilledSections(blueprint)).toBe(1);
  });

  it('is zero for a blank blueprint', () => {
    expect(blueprintFilledSections(createBlankBlueprint('bp-1', 'proj-1'))).toBe(0);
  });
});
