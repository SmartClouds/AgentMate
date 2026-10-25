import { describe, expect, it } from 'vitest';
import { parseFencedFiles } from './files.js';

describe('parseFencedFiles', () => {
  it('reads files named after file: on the fence line', () => {
    const text = [
      'Here is the scene.',
      '```html file:index.html',
      '<div id="t"></div>',
      '```',
      '```js file:scene.js',
      'Studio.scene({ render() {} });',
      '```',
    ].join('\n');
    expect(parseFencedFiles(text)).toEqual([
      { path: 'index.html', content: '<div id="t"></div>\n' },
      { path: 'scene.js', content: 'Studio.scene({ render() {} });\n' },
    ]);
  });

  it('takes the other ways models name a file', () => {
    const text = [
      '```css title="style.css"',
      'body{}',
      '```',
      '```file=assets/data.json',
      '{}',
      '```',
      '```html',
      '<!-- file: index.html -->',
      '<p>سلام</p>',
      '```',
    ].join('\n');
    expect(parseFencedFiles(text).map((f) => f.path)).toEqual([
      'style.css',
      'assets/data.json',
      'index.html',
    ]);
    expect(parseFencedFiles(text)[2]?.content).toBe('<p>سلام</p>\n');
  });

  it('keeps nested backticks inside a longer fence, and skips blocks with no name', () => {
    const text = [
      '````js file:scene.js',
      'const s = `a ${1}`;',
      '```not a fence```',
      '````',
      '```',
      'loose',
      '```',
    ].join('\n');
    expect(parseFencedFiles(text)).toEqual([
      { path: 'scene.js', content: 'const s = `a ${1}`;\n```not a fence```\n' },
    ]);
  });

  it('returns nothing for an answer without files', () => {
    expect(parseFencedFiles('I could not.')).toEqual([]);
  });
});
