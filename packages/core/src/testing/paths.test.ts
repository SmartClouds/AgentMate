import { describe, expect, it } from 'vitest';
import { isWithin, joinRel, normalizeRel, relativeTo, workspaceRelative } from './paths.js';

describe('workspace relative paths', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizeRel('a\\b/./c/../d')).toBe('a/b/d');
    expect(normalizeRel('./')).toBe('');
    expect(joinRel('', 'e2e', '.')).toBe('e2e');
  });

  it('checks containment by whole segments', () => {
    expect(isWithin('apps/desktop/src/a.ts', 'apps/desktop')).toBe(true);
    expect(isWithin('apps/desktop-old/a.ts', 'apps/desktop')).toBe(false);
    expect(isWithin('anything', '')).toBe(true);
    expect(relativeTo('apps/desktop/src/a.ts', 'apps/desktop')).toBe('src/a.ts');
  });

  it('maps absolute Windows report paths regardless of case and separators', () => {
    expect(
      workspaceRelative('e:\\Runova\\apps\\desktop\\src\\a.test.ts', 'E:\\Runova', 'apps/desktop'),
    ).toBe('apps/desktop/src/a.test.ts');
  });

  it('maps file URLs on both platforms', () => {
    expect(workspaceRelative('file:///C:/work/app/test/a_test.dart', 'C:\\work\\app', '')).toBe(
      'test/a_test.dart',
    );
    expect(workspaceRelative('file:///home/me/app/test/a%20b_test.dart', '/home/me/app', '')).toBe(
      'test/a b_test.dart',
    );
  });

  it('resolves relative report paths against the project root', () => {
    expect(workspaceRelative('./spec/models/user_spec.rb', '/w', 'api')).toBe(
      'api/spec/models/user_spec.rb',
    );
  });

  it('refuses a path outside the workspace', () => {
    expect(workspaceRelative('/elsewhere/a.ts', '/w', '')).toBeNull();
  });
});
