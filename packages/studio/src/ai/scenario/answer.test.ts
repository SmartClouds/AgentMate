import { describe, expect, it } from 'vitest';
import { applyOps } from '../../document/ops.js';
import { createDocument, createScene } from '../../document/schema.js';
import { FLICKS_PER_SECOND } from '../../time/flicks.js';
import { readScenarioAnswer, scenarioSeconds, scenarioToOps } from './answer.js';

const persian = {
  title: 'چرا آب مهم است',
  logline: 'یک ویدیوی کوتاه درباره‌ی آب.',
  scenes: [
    { title: 'شروع', narration: 'آب زندگی است.', durationSeconds: 6 },
    {
      title: 'پایان',
      narration: 'از آب محافظت کنیم.',
      onScreenText: ['آب = زندگی'],
      durationSeconds: 4.02,
      transition: 'fade',
    },
  ],
};

function ids() {
  let n = 0;
  return () => `s${++n}`;
}

describe('readScenarioAnswer', () => {
  it('reads a Persian scenario and fills the defaults', () => {
    const read = readScenarioAnswer(`\`\`\`json\n${JSON.stringify(persian)}\n\`\`\``, 'fa');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.scenes[0]).toMatchObject({
      onScreenText: [],
      visualKind: 'motion',
      transition: 'cut',
      musicCue: '',
    });
    expect(scenarioSeconds(read.value)).toBeCloseTo(10.02);
  });

  it('lists every schema problem by path, for the repair round', () => {
    const broken = { logline: 'x', scenes: [{ title: '', narration: 3, durationSeconds: 0 }] };
    const read = readScenarioAnswer(JSON.stringify(broken), 'en');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.issues.some((i) => i.startsWith('scenes[0].title'))).toBe(true);
    expect(read.issues.some((i) => i.startsWith('scenes[0].narration'))).toBe(true);
    expect(read.issues.some((i) => i.startsWith('scenes[0].durationSeconds'))).toBe(true);
  });

  it('asks for Persian when a Persian video comes back in English', () => {
    const english = {
      logline: 'A short film about water.',
      scenes: [{ title: 'Start', narration: 'Water is life.', durationSeconds: 5 }],
    };
    const read = readScenarioAnswer(JSON.stringify(english), 'fa');
    expect(read).toEqual({
      ok: false,
      issues: ['Write the narration and on-screen text in Persian.'],
    });
  });

  it('refuses Chinese characters in any language', () => {
    const answer = {
      logline: 'x',
      scenes: [
        {
          title: 'a',
          narration: `Water ${String.fromCodePoint(0x6c34)} is life.`,
          durationSeconds: 5,
        },
      ],
    };
    const read = readScenarioAnswer(JSON.stringify(answer), 'en');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.issues[0]).toMatch(/Chinese/);
  });

  it('passes on the extraction problem when there is no JSON', () => {
    expect(readScenarioAnswer('Sorry, I cannot.', 'en')).toEqual({
      ok: false,
      issues: ['The answer has no JSON object in it.'],
    });
  });
});

describe('scenarioToOps', () => {
  it('replaces every scene in one valid edit, on frame boundaries', () => {
    const doc = createDocument({ id: 'v1', title: 'Untitled', language: 'fa' });
    doc.scenario.scenes.push(createScene({ id: 'old' }));
    const read = readScenarioAnswer(JSON.stringify(persian), 'fa');
    if (!read.ok) throw new Error('fixture');
    const { document, inverse } = applyOps(doc, scenarioToOps(doc, read.value, ids()));

    expect(document.title).toBe('چرا آب مهم است');
    expect(document.scenario.logline).toBe('یک ویدیوی کوتاه درباره‌ی آب.');
    expect(document.scenario.scenes.map((s) => s.id)).toEqual(['s1', 's2']);
    const second = document.scenario.scenes[1];
    // 4.02 s at 30 fps rounds to frame 121 (4.0333 s).
    expect(second?.targetDuration).toBe((121 * FLICKS_PER_SECOND) / 30);
    expect(second?.transitionOut).toEqual({ kind: 'fade', duration: FLICKS_PER_SECOND / 2 });
    expect(second?.onScreenText).toEqual(['آب = زندگی']);
    expect(applyOps(document, inverse).document).toEqual(doc);
  });

  it('keeps the title when asked to, and when the answer has none', () => {
    const doc = createDocument({ id: 'v1', title: 'Mine', language: 'en' });
    const answer = {
      logline: 'x',
      audience: '',
      tone: '',
      scenes: [
        {
          title: 'a',
          narration: 'b',
          onScreenText: [],
          durationSeconds: 3,
          visualKind: 'motion' as const,
          visualBrief: '',
          transition: 'cut' as const,
          musicCue: '',
        },
      ],
    };
    expect(scenarioToOps(doc, answer, ids()).some((op) => op.op === 'doc.set')).toBe(false);
    const titled = { ...answer, title: 'New' };
    expect(scenarioToOps(doc, titled, ids(), { keepTitle: true })[0]?.op).toBe('scenario.set');
  });
});

it('reads a scenario whose transition name is a near miss, without a repair round', () => {
  const answer = {
    logline: 'x',
    scenes: [{ title: 'a', narration: 'b', durationSeconds: 3, transition: 'fadeout' }],
  };
  const read = readScenarioAnswer(JSON.stringify(answer), 'en');
  expect(read.ok && read.value.scenes[0]?.transition).toBe('fade');
});
