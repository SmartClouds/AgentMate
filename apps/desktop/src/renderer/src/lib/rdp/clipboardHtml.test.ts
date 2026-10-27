import { describe, expect, it } from 'vitest';
import { FakeClipboardData } from '../../../../test/renderer/mocks/ironRdp';
import { misreadCfHtmlFragment, plainTextOfFragment, repairRemoteClipboard } from './clipboardHtml';

/** Builds a CF_HTML payload the way Windows does, with byte offsets in the header. */
function cfHtml(fragment: string): Uint8Array {
  const encoder = new TextEncoder();
  const before = '<html>\r\n<body>\r\n<!--StartFragment-->';
  const after = '<!--EndFragment-->\r\n</body>\r\n</html>';
  const pad = (value: number): string => String(value).padStart(12, '0');
  const headerLength =
    'Version:0.9\r\nStartHTML:\r\nEndHTML:\r\nStartFragment:\r\nEndFragment:\r\n'.length + 4 * 12;
  const startFragment = headerLength + encoder.encode(before).length;
  const endFragment = startFragment + encoder.encode(fragment).length;
  const endHtml = endFragment + encoder.encode(after).length;
  const header =
    `Version:0.9\r\nStartHTML:${pad(headerLength)}\r\nEndHTML:${pad(endHtml)}\r\n` +
    `StartFragment:${pad(startFragment)}\r\nEndFragment:${pad(endFragment)}\r\n`;
  return encoder.encode(`${header}${before}${fragment}${after}\0`);
}

/**
 * What the engine makes of CF_HTML bytes when it files them under CF_UNICODETEXT: whole code
 * units only, strict (a lone surrogate drops the text instead), trailing nulls trimmed.
 */
function readAsUtf16(bytes: Uint8Array): string {
  const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
  return new TextDecoder('utf-16le', { fatal: true }).decode(even).replace(/\0+$/, '');
}

const link =
  '<a href="https://order.example.com/product?anymessage=true&amp;prod=solo">Attention Required! | Cloudflare</a>';

describe('misreadCfHtmlFragment', () => {
  it('recovers the fragment from CF_HTML read as UTF-16', () => {
    const garbled = readAsUtf16(cfHtml(link));
    expect(garbled.startsWith('敖獲潩㩮')).toBe(true);
    expect(misreadCfHtmlFragment(garbled)).toBe(link);
  });

  it('keeps non-ASCII text in the fragment intact', () => {
    const fragment = '<b>café</b> über';
    expect(misreadCfHtmlFragment(readAsUtf16(cfHtml(fragment)))).toBe(fragment);
  });

  it('falls back to the fragment markers when the header offsets are unusable', () => {
    const text =
      'Version:0.9\r\nStartFragment:-1\r\nEndFragment:-1\r\n<!--StartFragment--><i>x</i><!--EndFragment-->';
    expect(misreadCfHtmlFragment(readAsUtf16(new TextEncoder().encode(`${text}\0`)))).toBe(
      '<i>x</i>',
    );
  });

  it('leaves real text alone', () => {
    expect(misreadCfHtmlFragment('https://example.com')).toBeNull();
    expect(misreadCfHtmlFragment('Version: 2.0 is out')).toBeNull();
    expect(misreadCfHtmlFragment('سلام')).toBeNull();
    expect(misreadCfHtmlFragment('')).toBeNull();
  });
});

describe('plainTextOfFragment', () => {
  it('gives the address for a copied link', () => {
    expect(plainTextOfFragment(link)).toBe(
      'https://order.example.com/product?anymessage=true&prod=solo',
    );
  });

  it('gives the text for a selection that is more than one link', () => {
    expect(plainTextOfFragment('See <a href="https://a.example">this page</a> now')).toBe(
      'See this page now',
    );
  });
});

describe('repairRemoteClipboard', () => {
  it('replaces garbled plain text and adds the HTML it came from', () => {
    const data = new FakeClipboardData();
    data.addText('text/plain', readAsUtf16(cfHtml(link)));
    const repaired = repairRemoteClipboard(data, () => new FakeClipboardData());
    expect(repaired).not.toBe(data);
    expect(repaired.entries).toEqual([
      { mimeType: 'text/html', value: link },
      {
        mimeType: 'text/plain',
        value: 'https://order.example.com/product?anymessage=true&prod=solo',
      },
    ]);
  });

  it('keeps HTML and images the engine did read correctly', () => {
    const png = Uint8Array.of(1, 2, 3);
    const data = new FakeClipboardData();
    data.addText('text/html', '<p>kept</p>');
    data.addText('text/plain', readAsUtf16(cfHtml(link)));
    data.addBinary('image/png', png);
    const repaired = repairRemoteClipboard(data, () => new FakeClipboardData());
    expect(repaired.entries).toEqual([
      { mimeType: 'text/html', value: '<p>kept</p>' },
      { mimeType: 'image/png', value: png },
      {
        mimeType: 'text/plain',
        value: 'https://order.example.com/product?anymessage=true&prod=solo',
      },
    ]);
  });

  it('returns clipboard data with nothing misread as it is', () => {
    const data = new FakeClipboardData();
    data.addText('text/plain', 'hello');
    data.addText('text/html', '<b>hello</b>');
    expect(repairRemoteClipboard(data, () => new FakeClipboardData())).toBe(data);
  });
});
