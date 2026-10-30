import { describe, expect, it } from 'vitest';
import { parseVaultQuery, searchEntries, sortEntries } from './search.js';
import type { VaultEntrySummary } from './summary.js';

let counter = 0;
function summary(overrides: Partial<VaultEntrySummary>): VaultEntrySummary {
  counter++;
  return {
    id: `e${counter}`,
    type: 'login',
    title: `Entry ${counter}`,
    tags: [],
    favorite: false,
    createdAt: counter,
    updatedAt: counter,
    lastUsedAt: null,
    username: '',
    service: '',
    keyId: '',
    urls: [],
    host: '',
    hasPassword: true,
    hasTotp: false,
    hasSecret: false,
    hasNotes: false,
    passwordUpdatedAt: null,
    expiresAt: null,
    fields: [],
    categoryId: null,
    autoSubmit: false,
    ...overrides,
  };
}

const ids = (hits: { summary: VaultEntrySummary }[]) => hits.map((h) => h.summary.title);

describe('parseVaultQuery', () => {
  it('splits plain terms from operators', () => {
    expect(parseVaultQuery('  git  tag:Work type:api is:fav hub ')).toEqual({
      terms: ['git', 'hub'],
      tags: ['work'],
      types: ['apiKey'],
      favoritesOnly: true,
    });
  });

  it('understands type aliases and ignores unknown ones as plain text', () => {
    expect(parseVaultQuery('type:logins type:notes type:custom type:key').types).toEqual([
      'login',
      'note',
      'custom',
      'apiKey',
    ]);
    expect(parseVaultQuery('type:wallet').terms).toEqual(['type:wallet']);
  });
});

describe('searchEntries', () => {
  const github = summary({
    title: 'GitHub',
    username: 'octocat',
    urls: ['https://www.github.com/login'],
    host: 'github.com',
    tags: ['Work'],
  });
  const gitlab = summary({ title: 'GitLab', username: 'dev', host: 'gitlab.com' });
  const legit = summary({ title: 'My legit bank', username: 'someone' });
  const mail = summary({ title: 'Mail', username: 'github-notify@example.com' });
  const cafe = summary({ title: 'Café Wi-Fi', type: 'custom', tags: ['Personal'] });
  const stripe = summary({ title: 'Stripe', type: 'apiKey', service: 'Stripe', keyId: 'pk_live' });
  const all = [mail, legit, gitlab, github, cafe, stripe];

  it('returns everything in title order for an empty query', () => {
    expect(ids(searchEntries(all, ''))).toEqual([
      'Café Wi-Fi',
      'GitHub',
      'GitLab',
      'Mail',
      'My legit bank',
      'Stripe',
    ]);
  });

  it('ranks a title prefix above a username match and a mid-word match', () => {
    expect(ids(searchEntries(all, 'github'))).toEqual(['GitHub', 'Mail']);
    expect(ids(searchEntries(all, 'git'))).toEqual(['GitHub', 'GitLab', 'My legit bank', 'Mail']);
  });

  it('requires every term to match somewhere', () => {
    expect(ids(searchEntries(all, 'git octo'))).toEqual(['GitHub']);
    expect(ids(searchEntries(all, 'git nothing'))).toEqual([]);
  });

  it('ignores case and accents', () => {
    expect(ids(searchEntries(all, 'CAFE'))).toEqual(['Café Wi-Fi']);
    expect(ids(searchEntries(all, 'café'))).toEqual(['Café Wi-Fi']);
  });

  it('matches the host even when the title does not', () => {
    const renamed = summary({ title: 'Work code', host: 'github.com' });
    expect(ids(searchEntries([renamed], 'github.com'))).toEqual(['Work code']);
  });

  it('matches letters in order in the title as a last resort', () => {
    expect(ids(searchEntries(all, 'gthb'))).toEqual(['GitHub']);
  });

  it('filters by tag, type and favorites', () => {
    expect(ids(searchEntries(all, 'tag:work'))).toEqual(['GitHub']);
    expect(ids(searchEntries(all, 'type:api'))).toEqual(['Stripe']);
    const fav = summary({ title: 'Fav', favorite: true });
    expect(ids(searchEntries([...all, fav], 'is:fav'))).toEqual(['Fav']);
  });

  it('applies the filters passed as options on top of the query', () => {
    expect(ids(searchEntries(all, 'git', { types: ['login'], tags: ['work'] }))).toEqual([
      'GitHub',
    ]);
    expect(ids(searchEntries(all, '', { favoritesOnly: true }))).toEqual([]);
  });

  it('gives favorites a small boost and breaks ties by recent use, then title', () => {
    const a = summary({ title: 'Bank B', lastUsedAt: 10 });
    const b = summary({ title: 'Bank A', lastUsedAt: 50 });
    const c = summary({ title: 'Bank C', lastUsedAt: null });
    expect(ids(searchEntries([a, c, b], 'bank'))).toEqual(['Bank A', 'Bank B', 'Bank C']);
    const favorite = summary({ title: 'Bank Z', favorite: true });
    expect(ids(searchEntries([a, c, b, favorite], 'bank'))[0]).toBe('Bank Z');
  });

  it('returns title highlight ranges on the original text', () => {
    const [hit] = searchEntries([cafe], 'wi');
    expect(hit.titleRanges).toEqual([[5, 7]]);
    const [accent] = searchEntries([cafe], 'cafe');
    expect(accent.titleRanges).toEqual([[0, 4]]);
    const [fuzzy] = searchEntries([github], 'gthb');
    expect(fuzzy.titleRanges).toEqual([
      [0, 1],
      [2, 3],
      [3, 4],
      [5, 6],
    ]);
  });

  it('searches api key service and custom field labels', () => {
    expect(ids(searchEntries(all, 'pk_live'))).toEqual(['Stripe']);
    const custom = summary({
      title: 'Door',
      type: 'custom',
      fields: [{ id: 'f', label: 'Alarm code', concealed: true, hasValue: true }],
    });
    expect(ids(searchEntries([custom], 'alarm'))).toEqual(['Door']);
  });
});

describe('sortEntries', () => {
  const a = summary({ title: 'b', createdAt: 1, updatedAt: 30, lastUsedAt: 5 });
  const b = summary({ title: 'A', createdAt: 3, updatedAt: 10, lastUsedAt: null });
  const c = summary({ title: 'c', createdAt: 2, updatedAt: 20, lastUsedAt: 9 });

  it('sorts by each mode without mutating the input', () => {
    const input = [a, b, c];
    expect(sortEntries(input, 'title').map((s) => s.title)).toEqual(['A', 'b', 'c']);
    expect(sortEntries(input, 'updated').map((s) => s.title)).toEqual(['b', 'c', 'A']);
    expect(sortEntries(input, 'created').map((s) => s.title)).toEqual(['A', 'c', 'b']);
    expect(sortEntries(input, 'recent').map((s) => s.title)).toEqual(['c', 'b', 'A']);
    expect(input).toEqual([a, b, c]);
  });
});
