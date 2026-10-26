import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTempDirs } from '../../test/tempDir.js';
import {
  GenError,
  geminiClipState,
  geminiDownloadClip,
  geminiImage,
  geminiStartClip,
  openaiImage,
} from './providers.js';

/** The provider calls on their own, with each answer a provider can give, from a stub fetch. */

const tempDir = useTempDirs();
const json = (status: number, value: unknown) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const answering =
  (...answers: (Response | Error)[]) =>
  async () => {
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  };
const base = { key: 'k' };
const picture = { prompt: 'p', size: '1K', aspectRatio: '1:1' };

describe('provider answers', () => {
  it('says a refused key plainly, marks server trouble and a dropped connection as worth retrying', async () => {
    await expect(
      openaiImage({
        ...base,
        fetch: answering(json(401, { error: { message: 'bad' } })),
        prompt: 'p',
        size: '1024x1024',
        quality: 'low',
      }),
    ).rejects.toThrow('OpenAI refused the key. Check it in Settings > AI.');
    const busy = await geminiImage({
      ...base,
      fetch: answering(json(503, { error: { message: 'overloaded' } })),
      ...picture,
    }).catch((e: unknown) => e);
    expect(busy).toMatchObject({
      retryable: true,
      refused: false,
      message: 'Google Gemini answered 503. overloaded',
    });
    const gone = await geminiImage({
      ...base,
      fetch: answering(new Error('ECONNRESET')),
      ...picture,
    }).catch((e: unknown) => e);
    expect(gone).toMatchObject({
      retryable: true,
      message: 'Google Gemini could not be reached: ECONNRESET',
    });
    const blocked = await geminiImage({
      ...base,
      fetch: answering(json(400, { error: { status: 'SAFETY', message: 'Blocked for safety.' } })),
      ...picture,
    }).catch((e: unknown) => e);
    expect(blocked).toMatchObject({
      refused: true,
      message: 'Google Gemini declined this prompt: Blocked for safety.',
    });
    const plain = await geminiImage({
      ...base,
      fetch: answering(new Response('oops', { status: 400 })),
      ...picture,
    }).catch((e: unknown) => e);
    expect(plain).toMatchObject({
      refused: false,
      retryable: false,
      message: 'Google Gemini answered 400. oops',
    });
  });

  it('notices an answer with no picture or clip in it', async () => {
    await expect(
      openaiImage({
        ...base,
        fetch: answering(json(200, { data: [] })),
        prompt: 'p',
        size: '1024x1024',
        quality: 'low',
      }),
    ).rejects.toThrow('OpenAI answered without a picture.');
    await expect(
      geminiImage({ ...base, fetch: answering(json(200, { steps: [] })), ...picture }),
    ).rejects.toThrow('Google Gemini answered without a picture.');
    await expect(
      geminiStartClip({
        ...base,
        fetch: answering(json(200, { steps: [] })),
        prompt: 'p',
        aspectRatio: '16:9',
      }),
    ).rejects.toThrow('Google Gemini Omni answered without a clip.');
  });

  it('takes a small clip sent inline, and reads a failed or waiting clip file', async () => {
    const inline = await geminiStartClip({
      ...base,
      fetch: answering(
        json(200, {
          id: 'i1',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'video', data: Buffer.from('clip').toString('base64') }],
            },
          ],
        }),
      ),
      prompt: 'p',
      aspectRatio: '16:9',
    });
    expect(inline.kind === 'inline' && Buffer.from(inline.bytes).toString()).toBe('clip');
    expect(
      await geminiClipState({
        ...base,
        fetch: answering(json(200, { state: 'FAILED', error: { message: 'Too long.' } })),
        file: 'files/x',
      }),
    ).toEqual({ state: 'failed', error: 'Too long.' });
    expect(
      await geminiClipState({
        ...base,
        fetch: answering(json(200, { state: 'PROCESSING' })),
        file: 'files/x',
      }),
    ).toEqual({
      state: 'waiting',
      error: null,
    });
  });

  it('starts a download over when the server ignores the range, rather than appending', async () => {
    const root = await tempDir();
    const dest = join(root, 'clip.mp4.part');
    await writeFile(dest, 'old half');
    await geminiDownloadClip({
      ...base,
      fetch: answering(new Response('whole clip', { status: 200 })),
      file: 'files/x',
      dest,
    });
    expect(await readFile(dest, 'utf8')).toBe('whole clip');
    await writeFile(dest, 'first ');
    await geminiDownloadClip({
      ...base,
      fetch: answering(new Response('second', { status: 206 })),
      file: 'files/x',
      dest,
    });
    expect(await readFile(dest, 'utf8')).toBe('first second');
    expect(new GenError('x').refused).toBe(false);
  });
});
