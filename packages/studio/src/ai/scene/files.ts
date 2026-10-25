/**
 * Reads the files of a scene out of an AI answer. Scene code comes back as fenced blocks, one per
 * file, rather than written to disk by the CLI: that needs no write permission, works the same
 * for every CLI, and nothing the CLI does can land outside the scene. Models name a block's file
 * in a few ways, and all of them are taken: `file:index.html` or `file=` on the fence line, a
 * `title="..."`, or a first-line comment such as `<!-- file: index.html -->`.
 */

export interface FencedFile {
  path: string;
  content: string;
}

const NAME_ON_FENCE = /(?:file[:=]\s*|title=["']?)([A-Za-z0-9_./-]+?)["']?(?:\s|$)/;
const NAME_IN_COMMENT = /^\s*(?:<!--|\/\/|\/\*|#)\s*file:\s*([A-Za-z0-9_./-]+)\s*(?:-->|\*\/)?\s*$/;

export function parseFencedFiles(text: string): FencedFile[] {
  const lines = text.split(/\r?\n/);
  const files: FencedFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^(`{3,})(.*)$/.exec(lines[i] as string);
    if (!open) {
      i++;
      continue;
    }
    const fence = open[1] as string;
    const info = open[2] ?? '';
    const body: string[] = [];
    i++;
    while (i < lines.length && !new RegExp(`^${fence}\\s*$`).test(lines[i] as string)) {
      body.push(lines[i] as string);
      i++;
    }
    i++;
    let path = NAME_ON_FENCE.exec(info)?.[1];
    if (!path && body.length > 0) {
      const named = NAME_IN_COMMENT.exec(body[0] as string);
      if (named) {
        path = named[1];
        body.shift();
      }
    }
    if (path) files.push({ path, content: body.length ? `${body.join('\n')}\n` : '' });
  }
  return files;
}
