import type { Aspect } from '../document/schema.js';

/**
 * Studio's fifteen visual styles. Each one tells the scenario writer and, from E33, the scene
 * generator what the film should look like: a palette, how things move, and what to avoid. They
 * are AgentMate's own descriptions of common motion-design families, written for this app.
 */

export interface StylePreset {
  id: string;
  name: string;
  /** One line for the picker. */
  summary: string;
  /** Background first, then the main colors, then the accent. */
  palette: string[];
  /** How things move, for the animator. */
  motion: string;
  /** Font stacks; the Arabic-script stack is used for Persian, Arabic and Urdu. */
  fonts: { latin: string; arabic: string };
  dos: string[];
  donts: string[];
  /** The formats it works best in. Every style can be used in any format. */
  formats: Aspect[];
}

const SANS = { latin: 'Inter, sans-serif', arabic: 'Vazirmatn, "Noto Sans Arabic", sans-serif' };
const NASKH = { latin: 'Inter, sans-serif', arabic: '"Noto Naskh Arabic", Vazirmatn, serif' };
const ALL: Aspect[] = ['16:9', '9:16', '1:1', '4:5'];

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: 'line-boil',
    name: 'Line boil',
    summary:
      'Hand-drawn outlines that wobble a little on every frame, like a sketchbook come alive.',
    palette: ['#FBF7EF', '#1F1F1F', '#E4572E', '#29335C'],
    motion:
      'Redraw outlines with a small random jitter about 12 times a second; move on held poses.',
    fonts: NASKH,
    dos: ['Thick dark outlines', 'Paper-colored background', 'One accent color per scene'],
    donts: ['Gradients', 'Perfectly smooth tweens', 'More than four colors'],
    formats: ALL,
  },
  {
    id: 'isometric',
    name: 'Isometric',
    summary: 'Clean 3D-looking blocks at a fixed angle, good for systems, cities and processes.',
    palette: ['#EEF2F7', '#3D5A80', '#98C1D9', '#EE6C4D'],
    motion:
      'Blocks rise and slide along the isometric axes with soft ease-out; build scenes up piece by piece.',
    fonts: SANS,
    dos: ['A fixed 30 degree grid', 'Light from one side', 'Small labels near objects'],
    donts: ['Perspective distortion', 'Busy textures', 'Text on the slanted faces'],
    formats: ['16:9', '1:1'],
  },
  {
    id: 'flat-vector',
    name: 'Flat vector',
    summary: 'Simple flat shapes and friendly characters, the classic explainer look.',
    palette: ['#FFFFFF', '#2B2D42', '#8D99AE', '#EF233C'],
    motion:
      'Pop in with a slight overshoot, slide in from the edges, keep each move under a second.',
    fonts: SANS,
    dos: ['Big simple shapes', 'Plenty of empty space', 'Icons that read at a glance'],
    donts: ['Drop shadows', 'Photo textures', 'Small detailed text'],
    formats: ALL,
  },
  {
    id: 'line-art',
    name: 'Line art',
    summary: 'Single-weight lines that draw themselves on, calm and precise.',
    palette: ['#0E1116', '#F5F5F5', '#7FDBCA', '#F7C548'],
    motion: 'Stroke lines on from start to end, then fill; slow, even pacing.',
    fonts: SANS,
    dos: ['One stroke width', 'Lines that connect ideas', 'Dark background with light lines'],
    donts: ['Filled heavy shapes', 'Fast cuts', 'Mixing many line weights'],
    formats: ALL,
  },
  {
    id: 'soft-3d',
    name: 'Soft 3D',
    summary: 'Rounded, matte 3D objects in pastel light, like clay toys.',
    palette: ['#F3EEF8', '#9381FF', '#B8B8FF', '#FFD8BE'],
    motion: 'Gentle floating and slow camera orbits; objects squash a little when they land.',
    fonts: SANS,
    dos: ['Rounded corners everywhere', 'Soft shadows', 'Few objects, large on screen'],
    donts: ['Hard metallic shine', 'Sharp edges', 'Dark moody lighting'],
    formats: ALL,
  },
  {
    id: 'shape-morph',
    name: 'Shape morph',
    summary: 'Geometric shapes that turn into one another to carry the story.',
    palette: ['#111111', '#FFFFFF', '#FF4D6D', '#4CC9F0'],
    motion: 'Every transition is a morph: a circle becomes a chart, a square becomes a phone.',
    fonts: SANS,
    dos: ['Continuity from scene to scene', 'Bold primary shapes', 'Rhythmic timing'],
    donts: ['Hard cuts', 'Clutter', 'Realistic illustration'],
    formats: ALL,
  },
  {
    id: 'sticker-explainer',
    name: 'Sticker explainer',
    summary: 'Cut-out stickers with white borders slapped onto a bright board.',
    palette: ['#FFE66D', '#FFFFFF', '#1A535C', '#FF6B6B'],
    motion: 'Stickers slap on with a quick scale and a small rotation, then hold.',
    fonts: SANS,
    dos: ['Thick white borders', 'Slight random rotation', 'Playful arrows and doodles'],
    donts: ['Perfect alignment', 'Muted colors', 'Long paragraphs'],
    formats: ['9:16', '1:1', '4:5'],
  },
  {
    id: 'hud',
    name: 'HUD',
    summary: 'A heads-up display: thin lines, data readouts and scanning grids.',
    palette: ['#05080F', '#00E5FF', '#7CFFCB', '#FF3864'],
    motion: 'Readouts count up, brackets snap around targets, scan lines sweep across.',
    fonts: { latin: '"JetBrains Mono", Inter, monospace', arabic: 'Vazirmatn, sans-serif' },
    dos: ['Thin glowing lines', 'Numbers that animate', 'Corner brackets and grids'],
    donts: ['Warm colors as the base', 'Rounded cartoon shapes', 'Heavy fills'],
    formats: ['16:9', '9:16'],
  },
  {
    id: 'collage',
    name: 'Collage',
    summary: 'Torn paper, cut-out photos and tape, layered like a scrapbook.',
    palette: ['#EDE6D6', '#2E2E2E', '#C1121F', '#669BBC'],
    motion: 'Pieces slide in and settle with a slight wobble; a stop-motion feel at 12 fps.',
    fonts: NASKH,
    dos: ['Paper textures', 'Visible tape and torn edges', 'Mixed scales'],
    donts: ['Clean vector perfection', 'Glow effects', 'Too many layers at once'],
    formats: ALL,
  },
  {
    id: 'aurora-glass',
    name: 'Aurora glass',
    summary: 'Frosted glass panels over slowly shifting colored light.',
    palette: ['#0B1026', '#7B5CFF', '#00D1FF', '#FF7AC6'],
    motion: 'The background drifts slowly; glass cards fade and rise in with a soft blur.',
    fonts: SANS,
    dos: ['Blurred color blobs behind', 'Semi-transparent cards', 'Calm, slow pacing'],
    donts: ['Hard outlines', 'Busy patterns', 'Small low-contrast text'],
    formats: ALL,
  },
  {
    id: 'bauhaus',
    name: 'Bauhaus',
    summary: 'Primary colors, circles, squares and strong grids.',
    palette: ['#F4F1E8', '#1D1D1B', '#E63946', '#F4A261'],
    motion: 'Shapes slide on a strict grid with mechanical, even timing; rotate in quarter turns.',
    fonts: SANS,
    dos: ['A visible grid', 'Large flat shapes', 'Bold type as a shape'],
    donts: ['Soft gradients', 'Organic curves everywhere', 'Decoration for its own sake'],
    formats: ALL,
  },
  {
    id: 'synthwave-vhs',
    name: 'Synthwave VHS',
    summary: 'Neon sunsets, chrome type and tape noise from the eighties.',
    palette: ['#14001F', '#FF2A6D', '#05D9E8', '#F9C80E'],
    motion:
      'A grid scrolls toward the horizon; type flickers in with scan lines and tracking jitter.',
    fonts: SANS,
    dos: ['Neon glow', 'A perspective grid floor', 'Light tape noise'],
    donts: ['Pastels', 'Flat daylight scenes', 'Noise so heavy text is unreadable'],
    formats: ['16:9', '9:16'],
  },
  {
    id: 'pixel-art',
    name: 'Pixel art',
    summary: 'Chunky pixels and limited palettes, like an old video game.',
    palette: ['#1B1B2F', '#E43F5A', '#F9F871', '#4ECCA3'],
    motion: 'Move in whole pixels at low frame rates; sprites step through a few frames.',
    fonts: { latin: '"Press Start 2P", monospace', arabic: 'Vazirmatn, sans-serif' },
    dos: ['A visible pixel grid', 'Eight colors or fewer', 'Game-style UI boxes'],
    donts: ['Smooth gradients', 'Anti-aliased curves', 'Tiny text'],
    formats: ALL,
  },
  {
    id: 'liquid',
    name: 'Liquid',
    summary: 'Blobs and fluid shapes that flow, merge and split.',
    palette: ['#0F0E17', '#FF8906', '#F25F4C', '#E53170'],
    motion:
      'Shapes stretch and merge with elastic easing; transitions pour from one scene to the next.',
    fonts: SANS,
    dos: ['Gooey merges', 'Warm saturated color', 'Continuous movement'],
    donts: ['Straight hard edges', 'Static holds longer than two seconds', 'Thin lines'],
    formats: ALL,
  },
  {
    id: 'variety-captions',
    name: 'Bold captions',
    summary:
      'Big punchy captions with stickers and emphasis words, made for vertical social video.',
    palette: ['#000000', '#FFFFFF', '#FFD60A', '#FF006E'],
    motion: 'Words pop on beat, key words grow and change color; quick zoom punches between lines.',
    fonts: { latin: 'Inter, sans-serif', arabic: 'Vazirmatn, sans-serif' },
    dos: ['Huge readable captions', 'One idea per line', 'Emphasis on key words'],
    donts: [
      'Small text',
      'Long sentences on screen',
      'Text near the bottom edge where apps draw buttons',
    ],
    formats: ['9:16'],
  },
];

export function styleById(id: string | null | undefined): StylePreset | undefined {
  return id ? STYLE_PRESETS.find((s) => s.id === id) : undefined;
}
