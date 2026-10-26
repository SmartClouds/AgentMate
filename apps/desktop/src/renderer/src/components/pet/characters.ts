import { isCustomPetId } from '@runova/core';
import boltSprite from '@/assets/pet/bolt.png';
import brickSprite from '@/assets/pet/brick.png';
import claudeSprite from '@/assets/pet/claude.webp';
import cocoaSprite from '@/assets/pet/cocoa.png';
import emberSprite from '@/assets/pet/ember.png';
import fandiSprite from '@/assets/pet/fandi.png';
import gremlinSprite from '@/assets/pet/gremlin.webp';
import hexSprite from '@/assets/pet/hex.png';
import mossSprite from '@/assets/pet/moss.png';
import noriSprite from '@/assets/pet/nori.png';
import opencodeSprite from '@/assets/pet/opencode.webp';
import pipSprite from '@/assets/pet/pip.png';
import tideSprite from '@/assets/pet/tide.png';

export type PetId = string;

export interface PetCharacter {
  id: PetId;
  name: string;
  blurb: string;
  src: string;
  /** Display height at 100% scale. */
  height: number;
  /** Sprite already loops; skip the CSS walk/idle bounce. */
  animated?: boolean;
  /**
   * Where the rope meets the drawn sprite, 0-1 from the top (hands / chest).
   * Bottom-aligned sprites that don't fill the hit box need this so the rope
   * is not left hanging in empty space above the character.
   */
  ropeGripY?: number;
  /** Where parachute risers meet this sprite (shoulders, hands, or harness). */
  chute?: Partial<ChuteFit>;
}

/** Parachute harness on the drawn sprite. */
export interface ChuteFit {
  /** 0-1 from the top of the sprite. Shoulders, hands, or chest strap. */
  y: number;
  /** How far each clip sits from center, as a fraction of sprite width. */
  spread: number;
  /** Gap above the sprite for the canopy, as a fraction of sprite height. */
  gap: number;
  /** Canopy width as a multiple of sprite width. Wider for big heads. */
  canopy: number;
}

const DEFAULT_CHUTE: ChuteFit = { y: 0.54, spread: 0.38, gap: 0.12, canopy: 1.55 };

export function chuteFitFor(pet: PetCharacter): ChuteFit {
  return { ...DEFAULT_CHUTE, ...pet.chute };
}

export const PET_CHARACTERS: PetCharacter[] = [
  {
    id: 'fandi',
    name: 'Fandi',
    blurb: 'A coder pup in an orange hoodie, out for a walk.',
    src: fandiSprite,
    height: 118,
    // Front paws sit just under the hoodie cuffs, and the risers clip on at the chest.
    ropeGripY: 0.62,
    chute: { y: 0.46, spread: 0.34, gap: 0.1, canopy: 1.62 },
  },
  {
    id: 'claude',
    name: 'Claude',
    blurb: 'An orange voxel in a palm-tree shirt.',
    src: claudeSprite,
    height: 90,
    animated: true,
    ropeGripY: 0.58,
    chute: { y: 0.64, spread: 0.42, gap: 0.12, canopy: 1.72 },
  },
  {
    id: 'gremlin',
    name: 'Gremlin',
    blurb: 'A green gremlin that greets you first.',
    src: gremlinSprite,
    height: 118,
    animated: true,
    ropeGripY: 0.48,
    chute: { y: 0.5, spread: 0.47, gap: 0.1, canopy: 1.58 },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    blurb: 'A monitor-headed coder on vacation.',
    src: opencodeSprite,
    height: 118,
    animated: true,
    ropeGripY: 0.5,
    chute: { y: 0.48, spread: 0.47, gap: 0.1, canopy: 1.58 },
  },
  {
    id: 'tide',
    name: 'Tide',
    blurb: 'A quiet orca that prefers the high line.',
    src: tideSprite,
    height: 118,
    ropeGripY: 0.5,
    chute: { y: 0.5, spread: 0.42, gap: 0.16, canopy: 1.52 },
  },
  {
    id: 'pip',
    name: 'Pip',
    blurb: 'A small pet that parks and watches.',
    src: pipSprite,
    height: 96,
    ropeGripY: 0.52,
    chute: { y: 0.48, spread: 0.38, gap: 0.22, canopy: 1.45 },
  },
  {
    id: 'brick',
    name: 'Brick',
    blurb: 'A cube-headed agent that climbs when you let it.',
    src: brickSprite,
    height: 118,
    ropeGripY: 0.42,
    chute: { y: 0.55, spread: 0.4, gap: 0.12, canopy: 1.7 },
  },
  {
    id: 'ember',
    name: 'Ember',
    blurb: 'A fox that warms up a corner of the desk.',
    src: emberSprite,
    height: 118,
    ropeGripY: 0.48,
    chute: { y: 0.56, spread: 0.36, gap: 0.18, canopy: 1.5 },
  },
  {
    id: 'nori',
    name: 'Nori',
    blurb: 'A charcoal cat that sits, then suddenly walks.',
    src: noriSprite,
    height: 118,
    ropeGripY: 0.48,
    chute: { y: 0.58, spread: 0.34, gap: 0.18, canopy: 1.55 },
  },
  {
    id: 'bolt',
    name: 'Bolt',
    blurb: 'A boxy robot with one yellow thought.',
    src: boltSprite,
    height: 118,
    ropeGripY: 0.4,
    chute: { y: 0.58, spread: 0.38, gap: 0.18, canopy: 1.68 },
  },
  {
    id: 'moss',
    name: 'Moss',
    blurb: 'A round frog that waits before it hops along.',
    src: mossSprite,
    height: 110,
    ropeGripY: 0.52,
    chute: { y: 0.52, spread: 0.4, gap: 0.12, canopy: 1.48 },
  },
  {
    id: 'cocoa',
    name: 'Cocoa',
    blurb: 'A capybara that is in no hurry at all.',
    src: cocoaSprite,
    height: 110,
    ropeGripY: 0.5,
    chute: { y: 0.54, spread: 0.38, gap: 0.14, canopy: 1.5 },
  },
  {
    id: 'hex',
    name: 'Hex',
    blurb: 'A chunky bee that patrols the screen edge.',
    src: hexSprite,
    height: 112,
    ropeGripY: 0.48,
    chute: { y: 0.56, spread: 0.36, gap: 0.18, canopy: 1.52 },
  },
];

export function petCharacter(id: PetId): PetCharacter {
  return PET_CHARACTERS.find((pet) => pet.id === id) ?? PET_CHARACTERS[0];
}

export function ropeGripYFor(pet: PetCharacter): number {
  return pet.ropeGripY ?? 0.5;
}

export function resolvePet(
  id: string,
  custom?: { name: string; src: string; animated?: boolean } | null,
): PetCharacter | null {
  const builtIn = PET_CHARACTERS.find((pet) => pet.id === id);
  if (builtIn) return builtIn;
  if (custom?.src) {
    return {
      id,
      name: custom.name,
      blurb: 'A pet you added.',
      src: custom.src,
      height: 118,
      animated: custom.animated ?? true,
      ropeGripY: 0.5,
      chute: DEFAULT_CHUTE,
    };
  }
  if (isCustomPetId(id)) return null;
  return PET_CHARACTERS[0];
}
