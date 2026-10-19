/**
 * Checks for the values the Deploy section renders into configuration: Compose project names,
 * domains, ports, IP addresses and networks, and env keys. Each check either returns the value in
 * the exact form to write (domains in their ASCII form, IPv6 in its canonical short form) or a
 * reason a person can act on. They are strict on purpose: a line break, a `;`, a brace or a quote
 * in an nginx or Compose file changes what the file means, so nothing that could carry one gets
 * through, including Unicode look-alikes that turn into one later. The server core checks the
 * same values again on its side.
 */

export type DeployValidation<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ValidIpAddress {
  /** Dotted quad for IPv4, the RFC 5952 short form for IPv6. */
  address: string;
  version: 4 | 6;
}

export interface ValidIpNetwork {
  /** The network address, host bits clear. */
  network: string;
  prefix: number;
  version: 4 | 6;
  /** `network/prefix`, ready to write. */
  value: string;
}

export interface ValidPortRange {
  start: number;
  end: number;
}

/** Longer project names make container, network and volume names unwieldy past any use. */
export const STACK_NAME_MAX_LENGTH = 63;

export const ENV_KEY_MAX_LENGTH = 255;

const pass = <T>(value: T): DeployValidation<T> => ({ ok: true, value });
const refuse = <T>(reason: string): DeployValidation<T> => ({ ok: false, reason });

/** C0 and C1 controls, and anything JavaScript counts as white space (NBSP, U+2028, U+3000...). */
function hasSpaceOrControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/u.test(char)) return true;
  }
  return false;
}

/** A character as it can appear in a reason. */
function shown(char: string): string {
  return char === '"' ? `'"'` : `"${char}"`;
}

/**
 * A Compose project name: lowercase letters, digits, dashes and underscores, starting with a
 * letter or digit. The same rule keeps it safe as a folder name on the server.
 */
export function validateStackName(input: string): DeployValidation<string> {
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter a name for the app.');
  if (input.length > STACK_NAME_MAX_LENGTH) {
    return refuse(`Keep the name to ${STACK_NAME_MAX_LENGTH} characters or fewer.`);
  }
  if (/[A-Z]/.test(input)) {
    return refuse("Use lowercase letters. Compose project names can't have capitals.");
  }
  if (!/^[a-z0-9]/.test(input)) return refuse('Start the name with a lowercase letter or a digit.');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(input)) {
    return refuse('Use only lowercase letters, digits, dashes and underscores.');
  }
  return pass(input);
}

const DOTTED_QUAD = /^[0-9]+(\.[0-9]+){3}$/;

export interface DomainCheckOptions {
  /** Accept `*.example.com`. Only the whole first label may be the wildcard. */
  allowWildcard?: boolean;
}

/**
 * A domain name, returned lowercased and in its ASCII form, so `bücher.de` comes back as
 * `xn--bcher-kva.de`. International names are converted by the platform's URL parser, which
 * applies IDNA mapping. That parser also quietly drops line breaks and tabs, decodes `%` escapes
 * and lets `;`, braces and quotes through, so the input is checked before it sees it, and its
 * output is checked again afterwards, since full-width punctuation maps to its ASCII twin.
 */
export function validateDomain(
  input: string,
  options: DomainCheckOptions = {},
): DeployValidation<string> {
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter a domain.');
  if (input.length > 1000) return refuse('That is far too long to be a domain.');
  if (hasSpaceOrControl(input)) return refuse("A domain can't contain spaces or line breaks.");
  if (input.includes('/') || input.includes(':')) {
    return refuse('Enter just the domain, without http://, a path or a port.');
  }
  const stray = [...input].find((char) => char < '\u0080' && !/[A-Za-z0-9.*-]/.test(char));
  if (stray) {
    return refuse(
      `${shown(stray)} isn't allowed in a domain. Use letters, digits, dots and hyphens.`,
    );
  }

  let name = input;
  let wildcard = '';
  if (input.includes('*')) {
    if (!options.allowWildcard) return refuse("Wildcards aren't allowed here.");
    if (!input.startsWith('*.') || input.slice(2).includes('*')) {
      return refuse('A wildcard can only be the whole first part, as in *.example.com.');
    }
    name = input.slice(2);
    wildcard = '*.';
  }
  if (DOTTED_QUAD.test(name)) return refuse("That's an IP address. Enter a domain name instead.");

  const needsIdna = [...name].some((char) => char > '\u007f') || /(^|\.)xn--/i.test(name);
  const ascii = needsIdna ? toAscii(name) : name.toLowerCase();
  if (ascii === null || !ascii.split('.').every(isDecodableLabel)) {
    return refuse("That isn't a valid international domain name.");
  }
  const problem = domainProblem(ascii);
  return problem ? refuse(problem) : pass(wildcard + ascii);
}

function toAscii(name: string): string | null {
  try {
    return new URL(`http://${name}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * An `xn--` label has to be real punycode. Older URL parsers refuse one that is not, but newer
 * ones (Node 24's among them) pass `xn--zz` through untouched, so it is decoded here as well.
 */
function isDecodableLabel(label: string): boolean {
  if (!label.startsWith('xn--')) return true;
  const decoded = decodePunycode(label.slice(4));
  return decoded !== null && decoded.length > 0;
}

/** RFC 3492 decoding, returning the code points, or null for input that is not punycode. */
function decodePunycode(input: string): number[] | null {
  const base = 36;
  const tMin = 1;
  const tMax = 26;
  const adapt = (delta: number, points: number, first: boolean): number => {
    let d = first ? Math.floor(delta / 700) : Math.floor(delta / 2);
    d += Math.floor(d / points);
    let k = 0;
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin));
      k += base;
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + 38));
  };
  const digit = (code: number): number => {
    if (code >= 0x30 && code <= 0x39) return code - 22;
    if (code >= 0x61 && code <= 0x7a) return code - 0x61;
    return -1;
  };

  const delimiter = input.lastIndexOf('-');
  const output: number[] = [];
  for (let j = 0; j < delimiter; j++) output.push(input.charCodeAt(j));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let pos = delimiter > 0 ? delimiter + 1 : 0; pos < input.length; ) {
    const before = i;
    let weight = 1;
    for (let k = base; ; k += base) {
      if (pos >= input.length) return null;
      const value = digit(input.charCodeAt(pos++));
      if (value < 0) return null;
      i += value * weight;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (value < t) break;
      weight *= base - t;
      if (i > 0x7fffffff || weight > 0x7fffffff) return null;
    }
    bias = adapt(i - before, output.length + 1, before === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i++;
  }
  return output;
}

/** The label rules, applied to the ASCII form (RFC 1035, RFC 1123, RFC 5891). */
function domainProblem(ascii: string): string | null {
  if (DOTTED_QUAD.test(ascii)) return "That's an IP address. Enter a domain name instead.";
  if (ascii.endsWith('.')) return 'Leave out the trailing dot.';
  if (ascii.startsWith('.')) return "A domain can't start with a dot.";
  const labels = ascii.split('.');
  if (labels.includes('')) return "A domain can't have two dots in a row.";
  if (labels.length < 2) return 'Use a full domain, such as example.com.';
  if (ascii.length > 253) {
    return 'A domain can be at most 253 characters long, counting its ASCII form.';
  }
  for (const label of labels) {
    if (!/^[a-z0-9-]+$/.test(label)) {
      return "A domain can't contain punctuation other than dots and hyphens, in any width.";
    }
    if (label.length > 63) return 'Each part between the dots can be at most 63 characters long.';
    if (label.startsWith('-') || label.endsWith('-')) {
      return "A part of a domain can't start or end with a hyphen.";
    }
    if (label.slice(2, 4) === '--' && !label.startsWith('xn--')) {
      return 'Two hyphens in the third and fourth places are kept for international names (xn--).';
    }
  }
  const tld = labels[labels.length - 1];
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]+)$/.test(tld)) {
    return 'The last part of a domain is letters, like .com or .de.';
  }
  return null;
}

/** A port from 1 to 65535, as a number or as decimal digits with no sign, spaces or leading zeros. */
export function validatePort(input: string | number): DeployValidation<number> {
  if (typeof input === 'number') {
    if (!Number.isInteger(input)) return refuse('A port is a whole number from 1 to 65535.');
    return portInRange(input);
  }
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter a port.');
  if (!/^[0-9]+$/.test(input)) return refuse('A port is a whole number from 1 to 65535.');
  if (input.length > 1 && input.startsWith('0')) return refuse('Leave out leading zeros.');
  if (input.length > 5) return refuse('Ports go from 1 to 65535.');
  return portInRange(Number(input));
}

function portInRange(port: number): DeployValidation<number> {
  return port >= 1 && port <= 65535 ? pass(port) : refuse('Ports go from 1 to 65535.');
}

/** `8000-8010`, or a single port as a range of one. */
export function validatePortRange(input: string | number): DeployValidation<ValidPortRange> {
  if (typeof input === 'number') {
    const port = validatePort(input);
    return port.ok ? pass({ start: port.value, end: port.value }) : port;
  }
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter a port or a range.');
  const parts = input.split('-');
  if (parts.length > 2) return refuse('A range has one dash, as in 8000-8010.');
  const start = validatePort(parts[0]);
  if (!start.ok) return start;
  const end = parts.length === 2 ? validatePort(parts[1]) : start;
  if (!end.ok) return end;
  if (start.value > end.value) {
    return refuse("The first port of a range can't be higher than the last.");
  }
  return pass({ start: start.value, end: end.value });
}

export interface IpAddressCheckOptions {
  /** Accept only this family. */
  version?: 4 | 6;
}

/**
 * An IPv4 or IPv6 address. IPv4 must be four plain decimal numbers (`010` is octal to some tools,
 * so leading zeros are refused); IPv6 comes back in its canonical short form, without brackets
 * or a zone.
 */
export function validateIpAddress(
  input: string,
  options: IpAddressCheckOptions = {},
): DeployValidation<ValidIpAddress> {
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter an IP address.');
  if (hasSpaceOrControl(input)) return refuse("An IP address can't contain spaces or line breaks.");
  const v6 = input.includes(':') || input.startsWith('[');
  if (options.version === 4 && v6) return refuse('Enter an IPv4 address, such as 192.0.2.10.');
  if (options.version === 6 && !v6) return refuse('Enter an IPv6 address, such as 2001:db8::10.');
  if (v6) {
    const groups = parseIpv6(input);
    return typeof groups === 'string'
      ? refuse(groups)
      : pass({ address: formatIpv6(groups), version: 6 });
  }
  const octets = parseIpv4(input);
  return typeof octets === 'string'
    ? refuse(octets)
    : pass({ address: octets.join('.'), version: 4 });
}

function parseIpv4(input: string): number[] | string {
  const parts = input.split('.');
  const shape = 'An IPv4 address is four numbers from 0 to 255, separated by dots.';
  if (parts.length !== 4) return shape;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return shape;
    if (part.length > 1 && part.startsWith('0')) {
      return 'Leave out leading zeros. Some tools read 010 as octal, which makes the address ambiguous.';
    }
    const octet = Number(part);
    if (octet > 255) return 'Each number in an IPv4 address goes from 0 to 255.';
    octets.push(octet);
  }
  return octets;
}

/** The eight 16-bit groups of an IPv6 address, or why it is not one. */
function parseIpv6(input: string): number[] | string {
  const invalid = "That isn't a valid IPv6 address.";
  if (input.includes('%')) return "Leave out the zone (the part after %). It can't be used here.";
  if (input.includes('[') || input.includes(']')) return 'Leave out the square brackets.';
  if (!/^[0-9A-Fa-f:.]+$/.test(input)) return invalid;
  const halves = input.split('::');
  if (halves.length > 2) return invalid;
  if (halves.length === 1) {
    const groups = ipv6Groups(halves[0], true);
    return groups?.length === 8 ? groups : invalid;
  }
  const left = ipv6Groups(halves[0], false);
  const right = ipv6Groups(halves[1], true);
  if (!left || !right) return invalid;
  const zeros = 8 - left.length - right.length;
  if (zeros < 1) return invalid;
  return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

/** Colon-separated groups; an embedded IPv4 address may only be the very last part. */
function ipv6Groups(side: string, allowIpv4: boolean): number[] | null {
  if (side === '') return [];
  const parts = side.split(':');
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    if (allowIpv4 && index === parts.length - 1 && part.includes('.')) {
      const octets = parseIpv4(part);
      if (typeof octets === 'string') return null;
      groups.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/** RFC 5952: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
function formatIpv6(groups: readonly number[]): string {
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const [high, low] = [groups[6], groups[7]];
    return `::ffff:${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  let bestStart = -1;
  let bestLength = 1;
  for (let start = 0; start < 8; ) {
    if (groups[start] !== 0) {
      start++;
      continue;
    }
    let end = start;
    while (end < 8 && groups[end] === 0) end++;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestStart < 0) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
}

/**
 * A network in CIDR notation. Host bits must be clear: `10.0.0.5/24` is refused with the network
 * that was probably meant, since firewalls and nginx would otherwise each guess differently.
 */
export function validateCidr(input: string): DeployValidation<ValidIpNetwork> {
  if (typeof input !== 'string' || input.length === 0) {
    return refuse('Enter a network, such as 10.0.0.0/8.');
  }
  const parts = input.split('/');
  if (parts.length === 1) return refuse('Add a / and a prefix length, as in 10.0.0.0/8.');
  if (parts.length > 2) return refuse('A network has one /, as in 10.0.0.0/8.');
  const address = validateIpAddress(parts[0]);
  if (!address.ok) return address;
  const { version } = address.value;
  const max = version === 4 ? 32 : 128;
  if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[1]) || Number(parts[1]) > max) {
    return refuse(`The prefix length is a number from 0 to ${max}.`);
  }
  const prefix = Number(parts[1]);
  const network = maskAddress(address.value, prefix);
  if (network !== address.value.address) {
    return refuse(
      `${address.value.address}/${prefix} has bits set past the prefix. The network is ${network}/${prefix}.`,
    );
  }
  return pass({ network, prefix, version, value: `${network}/${prefix}` });
}

/** A CIDR network, or a bare address taken as a network of one host (/32 or /128). */
export function validateIpOrCidr(input: string): DeployValidation<ValidIpNetwork> {
  if (typeof input === 'string' && input.includes('/')) return validateCidr(input);
  const address = validateIpAddress(input);
  if (!address.ok) return address;
  const { version } = address.value;
  const prefix = version === 4 ? 32 : 128;
  const network = address.value.address;
  return pass({ network, prefix, version, value: `${network}/${prefix}` });
}

function maskAddress(address: ValidIpAddress, prefix: number): string {
  if (address.version === 4) {
    const octets = address.address.split('.').map(Number);
    return octets.map((octet, index) => octet & bitMask(prefix - index * 8, 8)).join('.');
  }
  const groups = parseIpv6(address.address) as number[];
  return formatIpv6(groups.map((group, index) => group & bitMask(prefix - index * 16, 16)));
}

/** The mask for one part of `width` bits when `bits` of it fall inside the prefix. */
function bitMask(bits: number, width: number): number {
  const kept = Math.max(0, Math.min(width, bits));
  return ((1 << width) - 1) & ~((1 << (width - kept)) - 1);
}

/**
 * An environment variable name: a letter or underscore, then letters, digits, underscores, dots
 * or dashes. That is what the Environments tab reads and what Compose's .env parser accepts;
 * only names without dots or dashes can also be used as `${NAME}` in a compose file.
 */
export function validateEnvKey(input: string): DeployValidation<string> {
  if (typeof input !== 'string' || input.length === 0) return refuse('Enter a key.');
  if (input.length > ENV_KEY_MAX_LENGTH) {
    return refuse(`Keep keys to ${ENV_KEY_MAX_LENGTH} characters or fewer.`);
  }
  if (!/^[A-Za-z_]/.test(input)) return refuse('Start a key with a letter or an underscore.');
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(input)) {
    return refuse('Use only letters, digits, underscores, dots and dashes in a key.');
  }
  return pass(input);
}
