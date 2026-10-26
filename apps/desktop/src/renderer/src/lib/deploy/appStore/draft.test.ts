import { findCatalogTemplate } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { checkDraft, initialDraft, paramsFromDraft, regenerate, secretsInUse } from './draft';

const redis = findCatalogTemplate('redis');
const ollama = findCatalogTemplate('ollama');
const wordpress = findCatalogTemplate('wordpress');
if (!redis || !ollama || !wordpress) throw new Error('catalog changed');

describe('the install draft', () => {
  it('starts from the defaults, a free name and fresh passwords', () => {
    const draft = initialDraft(redis, ['redis']);
    expect(draft.name).toBe('redis-2');
    expect(draft.version).toBe(redis.defaultVersion);
    expect(draft.values.port).toBe('6379');
    expect(draft.secrets.REDIS_PASSWORD).toHaveLength(32);
    expect(initialDraft(redis, []).secrets.REDIS_PASSWORD).not.toBe(draft.secrets.REDIS_PASSWORD);
  });

  it('turns typed numbers into numbers and leaves blanks out', () => {
    expect(paramsFromDraft(redis, { port: ' 16379 ' })).toEqual({ port: 16379 });
    expect(paramsFromDraft(redis, { port: '' })).toEqual({});
  });

  it('checks a ready draft into what the install sends', () => {
    const draft = initialDraft(redis, []);
    const check = checkDraft(redis, draft, []);
    expect(check.problems).toEqual({});
    expect(check.render?.ports[0].hostIp).toBe('127.0.0.1');
    expect(check.secrets).toEqual(draft.secrets);
    expect(check.domain).toBeNull();
  });

  it('keys every problem by its field', () => {
    const draft = {
      ...initialDraft(redis, []),
      name: 'redis',
      values: { port: '99999' },
      secrets: { REDIS_PASSWORD: 'weak' },
      expose: true,
      domain: 'not a domain',
    };
    const { problems, render } = checkDraft(redis, draft, ['redis']);
    expect(Object.keys(problems).sort()).toEqual(['REDIS_PASSWORD', 'domain', 'name', 'port']);
    expect(problems.name).toBe('An app called redis is already on this server.');
    expect(render).toBeNull();
  });

  it('sends only the secrets the choices use', () => {
    const all = ollama.secrets.map((spec) => spec.key);
    const draft = initialDraft(ollama, []);
    const used = secretsInUse(ollama, paramsFromDraft(ollama, draft.values)).map((s) => s.key);
    const check = checkDraft(ollama, draft, []);
    expect(Object.keys(check.secrets).sort()).toEqual([...used].sort());
    expect(used.length).toBeLessThanOrEqual(all.length);
  });

  it('puts a domain into the app settings when it goes on one', () => {
    const draft = { ...initialDraft(wordpress, []), expose: true, domain: 'Blog.Example.com' };
    const check = checkDraft(wordpress, draft, []);
    expect(check.problems).toEqual({});
    expect(check.domain).toBe('blog.example.com');
    expect(check.render?.publicUrl).toBe('https://blog.example.com');
  });

  it('makes a new password that passes the rules', () => {
    const [spec] = redis.secrets;
    const value = regenerate(spec);
    expect(value).toHaveLength(spec.length);
  });
});
