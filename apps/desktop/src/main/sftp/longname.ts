/**
 * Owner and group from the `ls -l` style line an SFTP version 3 server sends with each entry
 * (the `longname`). The protocol says clients must not parse it, yet it is the only place the
 * names are: the attributes carry numeric ids alone. So this reads the common layout
 * (`-rw-r--r--  1 deploy  www-data  1234 Jan  5 10:12 index.html`, as OpenSSH, Dropbear and
 * ProFTPD send it) and gives up, with nulls, on anything else.
 */

/** A mode column: the type letter, nine permission letters, and maybe an ACL or xattr marker. */
const MODE = /^[-dlbcpsD?][-rwxsStT]{9}[+@.]?$/;
/** A link count. */
const LINKS = /^\d+$/;

export interface LongnameOwner {
  /** The owner's name, or its numeric id when the server knows no name for it. */
  owner: string | null;
  group: string | null;
}

export function parseLongname(longname: string): LongnameOwner {
  // Owner and group come before the size, date and name, so spaces in the name never matter.
  const fields = longname.trim().split(/\s+/);
  if (fields.length < 5 || !MODE.test(fields[0]) || !LINKS.test(fields[1])) {
    return { owner: null, group: null };
  }
  return { owner: fields[2], group: fields[3] };
}
