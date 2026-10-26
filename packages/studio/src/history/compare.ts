import type { FieldChange, ProposalChange } from '../ai/edit/answer.js';
import type { Clip, Scene, StudioDocument } from '../document/schema.js';
import { flicksToSeconds } from '../time/flicks.js';

/**
 * What changed between two versions of a video (E39), as the list an AI proposal shows: the
 * title, the scenario's fields, scenes added, removed, moved or changed (their animation code
 * among them), clips and tracks. Read from the two whole documents, so it compares any two
 * versions, however far apart.
 */

const seconds = (flicks: number) => `${Math.round(flicksToSeconds(flicks) * 100) / 100} s`;

function field(changes: FieldChange[], name: string, label: string, before: string, after: string) {
  if (before !== after) changes.push({ field: name, label, before, after });
}

function sceneChanges(a: Scene, b: Scene): FieldChange[] {
  const changes: FieldChange[] = [];
  field(changes, 'title', 'Title', a.title, b.title);
  field(changes, 'narration', 'Narration', a.narration, b.narration);
  field(
    changes,
    'onScreenText',
    'On screen',
    a.onScreenText.join(' / '),
    b.onScreenText.join(' / '),
  );
  field(changes, 'durationSeconds', 'Length', seconds(a.targetDuration), seconds(b.targetDuration));
  field(changes, 'timing', 'Timing', a.timing, b.timing);
  field(changes, 'visualKind', 'Visual', a.visualKind, b.visualKind);
  field(changes, 'visualBrief', 'What it shows', a.visualBrief, b.visualBrief);
  field(
    changes,
    'transition',
    'Hand over',
    a.transitionOut?.kind ?? 'cut',
    b.transitionOut?.kind ?? 'cut',
  );
  field(changes, 'musicCue', 'Music', a.musicCue, b.musicCue);
  field(changes, 'voiceRef', 'Voice', a.voiceRef ?? 'none', b.voiceRef ?? 'none');
  field(changes, 'code', 'Animation', a.code.treeHash ?? 'none', b.code.treeHash ?? 'none');
  return changes;
}

function clipLabel(clip: Clip, names: ReadonlyMap<string, string>): string {
  const source = clip.source;
  if (source.type === 'text') return source.text;
  if (source.type === 'media') return names.get(source.hash) ?? 'a file';
  return 'a scene';
}

function clipChanges(a: Clip, b: Clip): FieldChange[] {
  const changes: FieldChange[] = [];
  field(changes, 'start', 'Start', seconds(a.start), seconds(b.start));
  field(changes, 'duration', 'Length', seconds(a.duration), seconds(b.duration));
  field(changes, 'gain', 'Volume', `${Math.round(a.gain * 100)}%`, `${Math.round(b.gain * 100)}%`);
  field(changes, 'fadeIn', 'Fade in', seconds(a.fadeIn), seconds(b.fadeIn));
  field(changes, 'fadeOut', 'Fade out', seconds(a.fadeOut), seconds(b.fadeOut));
  if (a.source.type === 'text' && b.source.type === 'text') {
    field(changes, 'text', 'Words', a.source.text, b.source.text);
  }
  return changes;
}

/** Positions (in `order`) of a longest increasing run of its values: the items that did not move. */
function inOrder(order: number[]): Set<number> {
  const tails: number[] = [];
  const tailAt: number[] = [];
  const previous: number[] = new Array(order.length).fill(-1);
  for (const [i, value] of order.entries()) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((tails[mid] as number) < value) low = mid + 1;
      else high = mid;
    }
    tails[low] = value;
    tailAt[low] = i;
    previous[i] = low > 0 ? (tailAt[low - 1] as number) : -1;
  }
  const kept = new Set<number>();
  for (let i = tailAt[tails.length - 1] ?? -1; i >= 0; i = previous[i] as number) kept.add(i);
  return kept;
}

export function compareDocuments(
  before: StudioDocument,
  after: StudioDocument,
  /** File names by hash, for clips that play imported media. */
  mediaNames: ReadonlyMap<string, string> = new Map(),
): ProposalChange[] {
  const out: ProposalChange[] = [];
  if (before.title !== after.title)
    out.push({ kind: 'title', before: before.title, after: after.title });

  const scenario: FieldChange[] = [];
  field(scenario, 'logline', 'Logline', before.scenario.logline, after.scenario.logline);
  field(scenario, 'audience', 'Audience', before.scenario.audience, after.scenario.audience);
  field(scenario, 'tone', 'Tone', before.scenario.tone, after.scenario.tone);
  field(scenario, 'language', 'Language', before.language, after.language);
  field(scenario, 'styleId', 'Style', before.styleId ?? 'none', after.styleId ?? 'none');
  const r1 = before.renderSettings;
  const r2 = after.renderSettings;
  field(scenario, 'aspect', 'Format', r1.aspect, r2.aspect);
  field(scenario, 'resolution', 'Render size', r1.resolution, r2.resolution);
  field(scenario, 'fps', 'Frame rate', String(r1.fps), String(r2.fps));
  field(scenario, 'quality', 'Quality', r1.quality, r2.quality);
  field(scenario, 'codec', 'Codec', r1.codec, r2.codec);
  if (scenario.length > 0) out.push({ kind: 'scenario', changes: scenario });

  const oldScenes = new Map(before.scenario.scenes.map((s, i) => [s.id, { scene: s, index: i }]));
  const newScenes = new Map(after.scenario.scenes.map((s, i) => [s.id, { scene: s, index: i }]));
  for (const [id, { scene, index }] of oldScenes) {
    if (!newScenes.has(id))
      out.push({ kind: 'scene-removed', sceneId: id, position: index + 1, title: scene.title });
  }
  // Moves are read among the scenes both versions have, so one added scene does not move them all,
  // and only scenes outside the longest run still in order count as moved: swapping two scenes
  // moves one, not both.
  const kept = (scenes: Scene[]) =>
    scenes.filter((s) => oldScenes.has(s.id) && newScenes.has(s.id)).map((s) => s.id);
  const keptBefore = kept(before.scenario.scenes);
  const stayed = inOrder(kept(after.scenario.scenes).map((id) => keptBefore.indexOf(id)));
  const keptAfter = kept(after.scenario.scenes);
  for (const [index, scene] of after.scenario.scenes.entries()) {
    const old = oldScenes.get(scene.id);
    if (!old) {
      out.push({
        kind: 'scene-added',
        sceneId: scene.id,
        position: index + 1,
        title: scene.title,
        narration: scene.narration,
      });
      continue;
    }
    if (!stayed.has(keptAfter.indexOf(scene.id)))
      out.push({
        kind: 'scene-moved',
        sceneId: scene.id,
        title: scene.title,
        from: old.index + 1,
        to: index + 1,
      });
    const changes = sceneChanges(old.scene, scene);
    if (changes.length > 0) {
      out.push({
        kind: 'scene-changed',
        sceneId: scene.id,
        position: index + 1,
        title: scene.title,
        changes,
      });
    }
  }

  const trackName = (doc: StudioDocument, id: string) =>
    doc.timeline.tracks.find((t) => t.id === id)?.name ?? id;
  const oldClips = new Map(before.timeline.clips.map((c) => [c.id, c]));
  const newClips = new Map(after.timeline.clips.map((c) => [c.id, c]));
  for (const [id, clip] of oldClips) {
    if (!newClips.has(id)) {
      out.push({
        kind: 'clip-removed',
        clipId: id,
        track: trackName(before, clip.trackId),
        label: clipLabel(clip, mediaNames),
      });
    }
  }
  for (const [id, clip] of newClips) {
    const old = oldClips.get(id);
    if (!old) {
      out.push({
        kind: 'clip-added',
        clipId: id,
        track: trackName(after, clip.trackId),
        label: clipLabel(clip, mediaNames),
        startSeconds: flicksToSeconds(clip.start),
      });
      continue;
    }
    const changes = clipChanges(old, clip);
    if (changes.length > 0) {
      out.push({
        kind: 'clip-changed',
        clipId: id,
        track: trackName(after, clip.trackId),
        label: clipLabel(clip, mediaNames),
        changes,
      });
    }
  }

  for (const track of after.timeline.tracks) {
    const old = before.timeline.tracks.find((t) => t.id === track.id);
    if (!old) continue;
    const changes: FieldChange[] = [];
    field(changes, 'muted', 'Muted', old.muted ? 'yes' : 'no', track.muted ? 'yes' : 'no');
    field(changes, 'solo', 'Solo', old.solo ? 'yes' : 'no', track.solo ? 'yes' : 'no');
    field(
      changes,
      'volume',
      'Volume',
      `${Math.round(old.volume * 100)}%`,
      `${Math.round(track.volume * 100)}%`,
    );
    if (changes.length > 0) out.push({ kind: 'track-changed', track: track.name, changes });
  }
  return out;
}
