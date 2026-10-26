import type { StudioDocument } from '../../document/schema.js';
import type { VideoStore } from '../project/videoStore.js';
import { readTree } from '../scenes/codeTree.js';

/**
 * Seeds a new video with one version of another (E39): the document as it was, and only the files
 * that version uses (its imported media with their records, its scenes' code trees and the word
 * timings of its narration). The new video's history starts at that version; the source keeps all
 * of its own.
 */
export async function seedBranch(input: {
  source: VideoStore;
  document: StudioDocument;
  target: VideoStore;
  id: string;
  title: string;
}): Promise<void> {
  const { source, target } = input;
  const copy = async (hash: string) => {
    const copied = await target.blobs.putFile(source.blobs.path(hash));
    if (copied.hash !== hash) throw new Error('A file of the video changed while it was copied.');
  };

  const media = new Set<string>();
  for (const clip of input.document.timeline.clips) {
    if (clip.source.type === 'media') media.add(clip.source.hash);
  }
  for (const hash of media) {
    const record = source.media(hash);
    if (!record) continue;
    await copy(hash);
    target.addMedia(record);
    const words = source.narrationWords(hash);
    if (words) {
      await copy(words);
      target.setNarrationWords(hash, words);
    }
  }

  const trees = new Set(
    input.document.scenario.scenes.flatMap((s) => (s.code.treeHash ? [s.code.treeHash] : [])),
  );
  for (const tree of trees) {
    await copy(tree);
    for (const file of (await readTree(source.blobs, tree)).files) await copy(file.hash);
  }

  target.apply({
    baseSeq: target.seq,
    ops: [{ op: 'doc.replace', document: { ...input.document, id: input.id, title: input.title } }],
    label: `Started from ${input.document.title}`,
  });
  for (const scene of input.document.scenario.scenes) {
    if (scene.code.treeHash) await target.mirrorScene(scene.id);
  }
  await target.flush();
}
