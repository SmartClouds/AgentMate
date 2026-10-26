import { describe, expect, it } from 'vitest';
import { isTitleBarBlankDoubleClick } from './titleBar';

function bar(): HTMLDivElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <span id="name">Runova</span>
    <button id="back" disabled><svg id="arrow"></svg></button>
    <button id="search" data-search-anchor=""><span id="placeholder">Search</span></button>
    <a id="link" href="#/">Home</a>`;
  return root;
}

describe('isTitleBarBlankDoubleClick', () => {
  it('counts the empty bar and its plain text as blank space', () => {
    const root = bar();
    expect(isTitleBarBlankDoubleClick({ target: root })).toBe(true);
    expect(isTitleBarBlankDoubleClick({ target: root.querySelector('#name') })).toBe(true);
  });

  it('ignores a double click on a button, even a disabled one, or on its icon', () => {
    const root = bar();
    expect(isTitleBarBlankDoubleClick({ target: root.querySelector('#back') })).toBe(false);
    expect(isTitleBarBlankDoubleClick({ target: root.querySelector('#arrow') })).toBe(false);
  });

  it('ignores the search box and links', () => {
    const root = bar();
    expect(isTitleBarBlankDoubleClick({ target: root.querySelector('#placeholder') })).toBe(false);
    expect(isTitleBarBlankDoubleClick({ target: root.querySelector('#link') })).toBe(false);
  });

  it('treats a target that is not an element as blank space', () => {
    expect(isTitleBarBlankDoubleClick({ target: null })).toBe(true);
  });
});
