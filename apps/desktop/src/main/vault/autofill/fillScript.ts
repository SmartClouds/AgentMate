import source from '../../../shared/vault/fillLoginForm.js?raw';

export interface FillCredentials {
  username: string;
  password: string;
  /** Press the sign-in button after filling. */
  submit: boolean;
}

/** What the filler reports back from the page. Nothing else ever comes back from it. */
export interface FillResult {
  username: boolean;
  password: boolean;
  submitted: boolean;
}

/** The filler is a function expression; a formatter may end the file with a semicolon. */
const FILLER = source.trim().replace(/;\s*$/, '');

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * JSON is valid JavaScript for the credentials, apart from two line separators older engines
 * reject. `<` is escaped too, so the script never holds a closing script tag.
 */
function literal(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll(LINE_SEPARATOR, '\\u2028')
    .replaceAll(PARAGRAPH_SEPARATOR, '\\u2029');
}

/** The script that fills one login page. Run it in the page's main frame only. */
export function buildFillScript(creds: FillCredentials): string {
  return `(${FILLER})(document, ${literal(creds)})`;
}

export function isFillResult(value: unknown): value is FillResult {
  const v = value as Partial<FillResult> | null;
  return (
    !!v &&
    typeof v.username === 'boolean' &&
    typeof v.password === 'boolean' &&
    typeof v.submitted === 'boolean'
  );
}
