import { describe, expect, it } from 'vitest';
import {
  confirmsEstimate,
  formatUsd,
  GenRequestError,
  genEstimate,
  normalizeGenRequest,
} from './estimate.js';

const prompt = 'A teapot on a wooden table';

describe('estimating a generation', () => {
  it('prices a picture from each provider and a clip, with how the figure was reached', () => {
    expect(genEstimate({ kind: 'image', engine: 'openai', prompt, quality: 'high' })).toMatchObject(
      {
        usd: 0.211,
        model: 'gpt-image-2.5-flare',
        basis: expect.stringMatching(/estimate/),
      },
    );
    expect(genEstimate({ kind: 'image', engine: 'gemini', prompt, size: '2K' })).toMatchObject({
      usd: 0.0504,
      model: 'gemini-nano-banana-2.1',
    });
    expect(genEstimate({ kind: 'video', engine: 'gemini', prompt })).toMatchObject({
      usd: 0.8,
      model: 'gemini-omni-1.1-flash',
      basis: expect.stringMatching(/chooses the length/),
    });
  });

  it('fills in defaults and refuses what a provider does not take', () => {
    expect(normalizeGenRequest({ kind: 'image', engine: 'openai', prompt })).toMatchObject({
      size: '1024x1024',
      quality: 'medium',
    });
    expect(normalizeGenRequest({ kind: 'image', engine: 'gemini', prompt })).toMatchObject({
      size: '1K',
      aspectRatio: '16:9',
    });
    const bad = [
      { kind: 'video', engine: 'openai', prompt },
      { kind: 'video', engine: 'gemini', prompt, aspectRatio: '1:1' },
      { kind: 'image', engine: 'openai', prompt, size: '640x480' },
      { kind: 'image', engine: 'gemini', prompt, size: '8K' },
      { kind: 'image', engine: 'gemini', prompt, aspectRatio: '7:3' },
    ] as const;
    for (const request of bad) expect(() => normalizeGenRequest(request)).toThrow(GenRequestError);
  });

  it('takes a confirmation only for the estimate as it is now', () => {
    const request = { kind: 'image', engine: 'gemini', prompt, size: '1K' } as const;
    expect(confirmsEstimate(request, 0.0336)).toBe(true);
    expect(confirmsEstimate(request, 0.03)).toBe(false);
    expect(confirmsEstimate({ ...request, size: '4K' }, 0.0336)).toBe(false);
    expect(formatUsd(0.0336)).toBe('$0.03');
    expect(formatUsd(0.006)).toBe('under a cent');
    expect(formatUsd(12.4)).toBe('$12');
  });
});
