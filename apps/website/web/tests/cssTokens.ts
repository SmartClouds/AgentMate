/**
 * Reads the custom properties declared in the CSS rule whose selector list is exactly `selector`
 * (order and whitespace do not matter). Comments are ignored. Returns an empty map when the rule is
 * missing, so a test comparing two files fails on the first token instead of throwing.
 */
export function readTokenBlock(css: string, selector: string[]): Map<string, string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const wanted = [...selector].sort().join(',');
  const tokens = new Map<string, string>();
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Statements such as `@import "x";` can sit between rules; the prelude starts after the last.
    const prelude = match[1].split(';').pop() ?? '';
    const selectors = prelude
      .split(',')
      .map((part) => part.trim())
      .sort()
      .join(',');
    if (selectors !== wanted) continue;
    for (const declaration of match[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, ' '));
    }
  }
  return tokens;
}
