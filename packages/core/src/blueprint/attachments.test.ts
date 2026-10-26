import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_FILE_HOST,
  BLUEPRINT_FILE_SCHEME,
  blueprintFileMarkdown,
  blueprintFileNameFromUrl,
  blueprintFileUrl,
  flattenAttachmentRefs,
  isImageMime,
  isInlineMedia,
  isVideoMime,
  referencedAttachmentNames,
  relinkLegacyAttachments,
  removeAttachmentRefs,
} from './attachments.js';

/**
 * A step's text is ordinary markdown that also travels into a generated prompt and
 * into the project's own files, where the app's URL scheme means nothing. So the
 * round trip between a file name and its URL has to be exact, and the flattening has
 * to leave no dead link behind.
 */

const PREFIX = `${BLUEPRINT_FILE_SCHEME}://${BLUEPRINT_FILE_HOST}/`;

describe('blueprintFileUrl and blueprintFileNameFromUrl', () => {
  it('round trip a plain name', () => {
    expect(blueprintFileUrl('shot-1.png')).toBe(`${PREFIX}shot-1.png`);
    expect(blueprintFileNameFromUrl(`${PREFIX}shot-1.png`)).toBe('shot-1.png');
  });

  it('round trip names that need encoding, including non-latin ones', () => {
    for (const name of ['my file.png', 'a+b.png', 'سلام.png', '100%.png', 'a&b.png']) {
      expect(blueprintFileNameFromUrl(blueprintFileUrl(name)), name).toBe(name);
    }
  });

  it('percent-encodes the name so a space or a hash cannot cut the URL short', () => {
    expect(blueprintFileUrl('my file.png')).toBe(`${PREFIX}my%20file.png`);
    expect(blueprintFileUrl('a#b.png')).toBe(`${PREFIX}a%23b.png`);
  });

  it('ignores a query string or a fragment appended to the URL', () => {
    expect(blueprintFileNameFromUrl(`${PREFIX}shot.png?v=2`)).toBe('shot.png');
    expect(blueprintFileNameFromUrl(`${PREFIX}shot.png#top`)).toBe('shot.png');
  });

  it('returns null for a URL that is not one of ours', () => {
    expect(blueprintFileNameFromUrl('https://example.com/shot.png')).toBeNull();
    expect(blueprintFileNameFromUrl('file:///c:/shot.png')).toBeNull();
    expect(blueprintFileNameFromUrl('')).toBeNull();
    expect(blueprintFileNameFromUrl(`${BLUEPRINT_FILE_SCHEME}://other-host/shot.png`)).toBeNull();
  });

  it('returns null rather than throwing on a malformed escape', () => {
    // decodeURIComponent throws on a lone %, and a doctored file would reach this.
    expect(blueprintFileNameFromUrl(`${PREFIX}%E0%A4%A`)).toBeNull();
    expect(blueprintFileNameFromUrl(PREFIX)).toBeNull();
  });
});

describe('mime helpers', () => {
  it('recognise images and videos, and nothing else as inline media', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isVideoMime('video/mp4')).toBe(true);
    expect(isInlineMedia('image/svg+xml')).toBe(true);
    expect(isInlineMedia('video/webm')).toBe(true);
    expect(isInlineMedia('application/pdf')).toBe(false);
    expect(isInlineMedia('text/plain')).toBe(false);
    expect(isInlineMedia('')).toBe(false);
  });
});

describe('blueprintFileMarkdown', () => {
  it('uses image syntax for inline media, which the preview swaps for a video tag', () => {
    expect(
      blueprintFileMarkdown({ fileName: 'clip.mp4', displayName: 'Demo', mime: 'video/mp4' }),
    ).toBe(`![Demo](${PREFIX}clip.mp4)`);
    expect(
      blueprintFileMarkdown({ fileName: 'shot.png', displayName: 'Login', mime: 'image/png' }),
    ).toBe(`![Login](${PREFIX}shot.png)`);
  });

  it('uses a plain link for anything the preview cannot draw in place', () => {
    expect(
      blueprintFileMarkdown({ fileName: 'spec.pdf', displayName: 'Spec', mime: 'application/pdf' }),
    ).toBe(`[Spec](${PREFIX}spec.pdf)`);
  });

  it('replaces brackets and newlines in the alt text, which would end the link early', () => {
    expect(
      blueprintFileMarkdown({
        fileName: 'shot.png',
        displayName: 'a [b] c\nd',
        mime: 'image/png',
      }),
    ).toBe(`![a  b  c d](${PREFIX}shot.png)`);
  });

  it('falls back to a generic alt when the display name is only whitespace', () => {
    expect(
      blueprintFileMarkdown({ fileName: 'shot.png', displayName: '  ', mime: 'image/png' }),
    ).toBe(`![attachment](${PREFIX}shot.png)`);
  });
});

describe('referencedAttachmentNames', () => {
  it('finds image and link references, and dedupes them', () => {
    const text = [
      `Here is the screen: ![Login](${PREFIX}shot.png)`,
      `and the spec: [Spec](${PREFIX}spec.pdf)`,
      `and the same screen again ![again](${PREFIX}shot.png)`,
    ].join('\n\n');
    expect([...referencedAttachmentNames(text)].sort()).toEqual(['shot.png', 'spec.pdf']);
  });

  it('decodes the name back to what the file is called on disk', () => {
    expect([...referencedAttachmentNames(`![x](${PREFIX}my%20file.png)`)]).toEqual(['my file.png']);
  });

  it('finds a reference written with angle brackets or a title', () => {
    expect([...referencedAttachmentNames(`![x](<${PREFIX}shot.png>)`)]).toEqual(['shot.png']);
    expect([...referencedAttachmentNames(`![x](${PREFIX}shot.png "a title")`)]).toEqual([
      'shot.png',
    ]);
  });

  it('ignores links to anywhere else', () => {
    expect(referencedAttachmentNames('[docs](https://example.com/a.png)').size).toBe(0);
    expect(referencedAttachmentNames('plain text with no links').size).toBe(0);
    expect(referencedAttachmentNames('').size).toBe(0);
  });
});

describe('flattenAttachmentRefs', () => {
  it('replaces a reference with a mention of the file by name', () => {
    expect(flattenAttachmentRefs(`See ![Login screen](${PREFIX}shot.png) for the layout.`)).toBe(
      'See [attached file: Login screen] for the layout.',
    );
  });

  it('uses a generic mention when the reference had no alt text', () => {
    expect(flattenAttachmentRefs(`![](${PREFIX}shot.png)`)).toBe('[attached file]');
    expect(flattenAttachmentRefs(`[  ](${PREFIX}spec.pdf)`)).toBe('[attached file]');
  });

  it('flattens every reference in the text and leaves nothing pointing at the scheme', () => {
    const text = `a ![One](${PREFIX}a.png) b [Two](${PREFIX}b.pdf) c`;
    const flattened = flattenAttachmentRefs(text);
    expect(flattened).toBe('a [attached file: One] b [attached file: Two] c');
    expect(flattened).not.toContain(BLUEPRINT_FILE_SCHEME);
  });

  it('leaves ordinary markdown links alone', () => {
    const text = 'see the [docs](https://example.com) and ![a](https://example.com/a.png)';
    expect(flattenAttachmentRefs(text)).toBe(text);
  });

  it('leaves text with no references untouched', () => {
    expect(flattenAttachmentRefs('nothing to do here')).toBe('nothing to do here');
    expect(flattenAttachmentRefs('')).toBe('');
  });
});

describe('removeAttachmentRefs', () => {
  it('drops only the references to the named file', () => {
    const text = `a ![One](${PREFIX}a.png) b ![Two](${PREFIX}b.png) c`;
    expect(removeAttachmentRefs(text, 'a.png')).toBe(`a  b ![Two](${PREFIX}b.png) c`);
  });

  it('drops every reference to that file, not just the first', () => {
    const text = `![x](${PREFIX}a.png) and ![y](${PREFIX}a.png)`;
    expect(removeAttachmentRefs(text, 'a.png')).toBe(' and ');
  });

  it('matches by the decoded name, not the encoded URL', () => {
    expect(removeAttachmentRefs(`![x](${PREFIX}my%20file.png)`, 'my file.png')).toBe('');
  });

  it('collapses the run of blank lines the removal leaves behind', () => {
    const text = `intro\n\n![x](${PREFIX}a.png)\n\noutro`;
    expect(removeAttachmentRefs(text, 'a.png')).toBe('intro\n\noutro');
  });

  it('leaves the text alone when the file is not referenced', () => {
    const text = `a ![One](${PREFIX}a.png) b`;
    expect(removeAttachmentRefs(text, 'other.png')).toBe(text);
    expect(removeAttachmentRefs('', 'a.png')).toBe('');
  });
});

describe('relinkLegacyAttachments', () => {
  it('points links saved before the rename at the current scheme', () => {
    const old =
      '![shot](agentmate-file://blueprint/a.png) and [log](agentmate-file://blueprint/b.txt)'; // legacy-name
    expect(relinkLegacyAttachments(old)).toBe(
      `![shot](${blueprintFileUrl('a.png')}) and [log](${blueprintFileUrl('b.txt')})`,
    );
    expect(referencedAttachmentNames(relinkLegacyAttachments(old))).toEqual(
      new Set(['a.png', 'b.txt']),
    );
  });

  it('leaves text without old links alone', () => {
    expect(relinkLegacyAttachments('plain text')).toBe('plain text');
  });
});
