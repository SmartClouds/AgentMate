import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { applyTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * Switches between Dark and Light and remembers the choice. The inline head script has already
 * applied the theme before this island hydrates, so the server render assumes Dark and the effect
 * corrects the label.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => setTheme(currentTheme()), []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';

  function toggle() {
    applyTheme(document.documentElement, next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be blocked; the theme still changes for this page.
    }
    setTheme(next);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={toggle}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  );
}
