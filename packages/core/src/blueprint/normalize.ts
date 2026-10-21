import { DEFAULT_RELAY_BUDGET } from '../relay/format.js';
import type {
  BlueprintAttachment,
  BlueprintPreset,
  BlueprintRelaySetting,
  BlueprintSection,
  BlueprintStepId,
  ProjectBlueprint,
} from '../types/index.js';
import { BLUEPRINT_STEP_IDS, isBlueprintStepId } from '../types/index.js';

export const DEFAULT_BLUEPRINT_DOCS_FOLDER = 'docs';

/**
 * The docs folder ends up inside a prompt an agent acts on, so it gets the same
 * suspicion as a path: relative only, no drive letter, no climbing out.
 */
export function normalizeDocsFolder(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BLUEPRINT_DOCS_FOLDER;
  const segments = value
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0) return DEFAULT_BLUEPRINT_DOCS_FOLDER;
  if (segments.some((segment) => segment === '..' || /^[A-Za-z]:$/.test(segment))) {
    return DEFAULT_BLUEPRINT_DOCS_FOLDER;
  }
  return segments.join('/');
}

/**
 * Stable, cheap hash of a section's text, used to tell whether a stored English
 * translation still matches what the user has typed. djb2, base36: short enough
 * to sit in a JSON record, and deterministic across main and renderer.
 */
export function blueprintTextHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function blankSection(stepId: BlueprintStepId, now: string): BlueprintSection {
  return {
    stepId,
    text: '',
    textEn: null,
    textEnHash: null,
    attachments: [],
    includeInAgentFile: false,
    updatedAt: now,
  };
}

export function normalizeBlueprintAttachment(value: unknown): BlueprintAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const fileName = typeof rec.fileName === 'string' ? rec.fileName : '';
  // The name becomes a path under the app data folder, so anything that isn't a
  // plain generated file name is dropped rather than sanitized into something else.
  if (!/^[A-Za-z0-9._-]+$/.test(fileName) || fileName.includes('..')) return null;
  const displayName = typeof rec.displayName === 'string' ? rec.displayName.trim() : '';
  return {
    id: typeof rec.id === 'string' && rec.id ? rec.id : fileName,
    fileName,
    displayName: displayName || fileName,
    mime: typeof rec.mime === 'string' ? rec.mime : 'application/octet-stream',
    size: typeof rec.size === 'number' && Number.isFinite(rec.size) ? Math.max(0, rec.size) : 0,
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
  };
}

function normalizeSections(value: unknown, now: string): BlueprintSection[] {
  const stored = new Map<BlueprintStepId, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      if (!isBlueprintStepId(rec.stepId) || stored.has(rec.stepId)) continue;
      stored.set(rec.stepId, rec);
    }
  }

  // Always one section per step, always in wizard order, so nothing downstream
  // has to cope with a step that isn't there.
  return BLUEPRINT_STEP_IDS.map((stepId) => {
    const rec = stored.get(stepId);
    if (!rec) return blankSection(stepId, now);
    const text = typeof rec.text === 'string' ? rec.text : '';
    const textEn = typeof rec.textEn === 'string' ? rec.textEn : null;
    return {
      stepId,
      text,
      textEn,
      // A hash without its translation is meaningless, and would make the next
      // generate skip a translation it never actually has.
      textEnHash: textEn && typeof rec.textEnHash === 'string' ? rec.textEnHash : null,
      attachments: Array.isArray(rec.attachments)
        ? rec.attachments
            .map(normalizeBlueprintAttachment)
            .filter((entry): entry is BlueprintAttachment => entry !== null)
        : [],
      includeInAgentFile: rec.includeInAgentFile === true,
      updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : now,
    };
  });
}

/** Below this a session cannot even read its task; above it no model has the window. */
const RELAY_BUDGET_MIN = 10_000;
const RELAY_BUDGET_MAX = 2_000_000;

/** The Relay split, off with the default budget unless the record says otherwise. */
export function normalizeBlueprintRelay(value: unknown): BlueprintRelaySetting {
  const rec = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const budget = rec.budgetTokens;
  const usable =
    typeof budget === 'number' &&
    Number.isInteger(budget) &&
    budget >= RELAY_BUDGET_MIN &&
    budget <= RELAY_BUDGET_MAX;
  return {
    enabled: rec.enabled === true,
    budgetTokens: usable ? budget : DEFAULT_RELAY_BUDGET,
  };
}

/**
 * Read-time normalizer for blueprints.json, the same role `withProjectDefaults`
 * plays for projects: fills in what an older or hand-edited record lacks so the
 * rest of the app can treat the shape as guaranteed.
 */
export function withBlueprintDefaults(value: ProjectBlueprint): ProjectBlueprint {
  const rec = value as unknown as Record<string, unknown>;
  const now = new Date().toISOString();
  const createdAt = typeof rec.createdAt === 'string' ? rec.createdAt : now;
  return {
    id: typeof rec.id === 'string' ? rec.id : '',
    projectId: typeof rec.projectId === 'string' ? rec.projectId : '',
    docsFolder: normalizeDocsFolder(rec.docsFolder),
    sections: normalizeSections(rec.sections, createdAt),
    finalPrompt: typeof rec.finalPrompt === 'string' ? rec.finalPrompt : '',
    finalPromptUpdatedAt:
      typeof rec.finalPromptUpdatedAt === 'string' ? rec.finalPromptUpdatedAt : null,
    // Defaults on, since asking first is the safer behaviour for an agent that
    // is about to write a folder full of files.
    confirmBeforeWriting: rec.confirmBeforeWriting !== false,
    relay: normalizeBlueprintRelay(rec.relay),
    createdAt,
    updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : createdAt,
  };
}

export function createBlankBlueprint(id: string, projectId: string): ProjectBlueprint {
  const now = new Date().toISOString();
  return {
    id,
    projectId,
    docsFolder: DEFAULT_BLUEPRINT_DOCS_FOLDER,
    sections: BLUEPRINT_STEP_IDS.map((stepId) => blankSection(stepId, now)),
    finalPrompt: '',
    finalPromptUpdatedAt: null,
    confirmBeforeWriting: true,
    relay: { enabled: false, budgetTokens: DEFAULT_RELAY_BUDGET },
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizeBlueprintPreset(value: unknown): BlueprintPreset | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id) return null;
  // A preset on an unknown step could never be shown, so there is nothing to keep.
  if (!isBlueprintStepId(rec.stepId)) return null;
  const label = typeof rec.label === 'string' ? rec.label.trim() : '';
  const text = typeof rec.text === 'string' ? rec.text : '';
  if (!label || !text.trim()) return null;
  return {
    id: rec.id,
    stepId: rec.stepId,
    label: label.slice(0, 60),
    text,
    createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : new Date().toISOString(),
  };
}

/** True once a blueprint holds anything worth keeping, used for empty states and badges. */
export function blueprintFilledSections(blueprint: ProjectBlueprint): number {
  return blueprint.sections.filter((section) => section.text.trim().length > 0).length;
}
