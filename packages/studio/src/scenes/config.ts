import { DESIGN_SIZES, type Scene, type StudioDocument } from '../document/schema.js';
import type { SceneConfig } from '../runtime/runtime.js';
import { directionOf } from '../text/languages.js';
import { flicksToSeconds } from '../time/flicks.js';

/** What a scene page is told about itself: its size, length, language and params. */
export function sceneConfig(doc: StudioDocument, scene: Scene): Partial<SceneConfig> {
  const size = DESIGN_SIZES[doc.renderSettings.aspect];
  return {
    duration: flicksToSeconds(scene.targetDuration),
    width: size.width,
    height: size.height,
    lang: doc.language,
    dir: directionOf(doc.language),
    params: scene.params,
    seed: scene.id,
  };
}
