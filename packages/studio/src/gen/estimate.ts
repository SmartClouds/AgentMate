import { STUDIO_GEN } from '@runova/core';
import type { GenEstimateView, GenRequest } from '../api.js';

/**
 * What a generated picture or clip will cost, from the providers' list prices in the catalog, and
 * whether the request is one the provider takes. Studio shows this before anything is billed, and
 * starts a generation only when the person confirmed this exact figure.
 */

export class GenRequestError extends Error {}

/** The request with its options filled in and checked; throws GenRequestError when it cannot be made. */
export function normalizeGenRequest(
  request: GenRequest,
): Required<Omit<GenRequest, 'quality' | 'size'>> & GenRequest {
  if (request.kind === 'video') {
    if (request.engine !== 'gemini') {
      throw new GenRequestError('Clips are made by Google Gemini Omni only.');
    }
    const video = STUDIO_GEN.video.gemini;
    const aspectRatio = request.aspectRatio ?? '16:9';
    if (!(video.aspectRatios as readonly string[]).includes(aspectRatio)) {
      throw new GenRequestError('Clips can be 16:9 or 9:16.');
    }
    return { ...request, aspectRatio };
  }
  if (request.engine === 'openai') {
    const image = STUDIO_GEN.image.openai;
    const size = request.size ?? '1024x1024';
    if (!(image.sizes as readonly string[]).includes(size)) {
      throw new GenRequestError(`OpenAI makes pictures at ${image.sizes.join(', ')}.`);
    }
    return { ...request, size, quality: request.quality ?? 'medium', aspectRatio: '' };
  }
  const image = STUDIO_GEN.image.gemini;
  const size = request.size ?? '1K';
  const aspectRatio = request.aspectRatio ?? '16:9';
  if (!(image.sizes as readonly string[]).includes(size)) {
    throw new GenRequestError(`Gemini makes pictures at ${image.sizes.join(', ')}.`);
  }
  if (!(image.aspectRatios as readonly string[]).includes(aspectRatio)) {
    throw new GenRequestError('Gemini does not make pictures of that shape.');
  }
  return { ...request, size, aspectRatio };
}

export function genEstimate(request: GenRequest): GenEstimateView {
  const r = normalizeGenRequest(request);
  if (r.kind === 'video') {
    const video = STUDIO_GEN.video.gemini;
    return {
      usd: round(video.pricePerSecond * video.expectedSeconds),
      model: video.model,
      label: video.label,
      basis: `$${video.pricePerSecond.toFixed(2)} a second at 720p, for a clip of about ${video.expectedSeconds} seconds. The model chooses the length, so the bill can differ.`,
    };
  }
  if (r.engine === 'openai') {
    const image = STUDIO_GEN.image.openai;
    const quality = r.quality ?? 'medium';
    return {
      usd: image.estimatePerImage[quality],
      model: image.model,
      label: image.label,
      basis: `About $${image.estimatePerImage[quality].toFixed(3)} for one ${quality} quality picture. OpenAI bills this model by token, so this is an estimate.`,
    };
  }
  const image = STUDIO_GEN.image.gemini;
  const size = r.size as keyof typeof image.pricePerImage;
  return {
    usd: image.pricePerImage[size],
    model: image.model,
    label: image.label,
    basis: `$${image.pricePerImage[size].toFixed(4)} for one ${size} picture.`,
  };
}

function round(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/** Whether what the person agreed to is the estimate for this request now. */
export function confirmsEstimate(request: GenRequest, confirmedUsd: number): boolean {
  return Math.abs(genEstimate(request).usd - confirmedUsd) < 1e-9;
}

/** "$0.80", or "under a cent". */
export function formatUsd(usd: number): string {
  if (usd < 0.01) return 'under a cent';
  return `$${usd < 10 ? usd.toFixed(2) : Math.round(usd)}`;
}
