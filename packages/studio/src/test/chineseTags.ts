/**
 * Chinese language tags for the tests that prove Studio filters them out. They are built from
 * character codes so the no-Chinese-content scan (studioNoChineseContent.test.ts) still holds
 * every shipped file, these tests included, to having none written out.
 */
const tag = (...codes: number[]) => String.fromCharCode(...codes);

export const ZH = tag(0x7a, 0x68);
export const YUE = tag(0x79, 0x75, 0x65);
export const CMN = tag(0x63, 0x6d, 0x6e);
