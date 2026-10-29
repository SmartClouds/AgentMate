import { useSearchParams } from 'react-router-dom';

/**
 * A section's tab, kept in the page's address as `&tab=` so the Deploy page remembers it along
 * with the section. The first tab is the default and stays out of the address.
 */
export function useTabParam<Tab extends string>(
  tabs: readonly Tab[],
  fallback: Tab,
): [Tab, (next: Tab) => void] {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = tabs.find((one) => one === asked) ?? fallback;

  function setTab(next: Tab): void {
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        if (next === fallback) updated.delete('tab');
        else updated.set('tab', next);
        return updated;
      },
      { replace: true },
    );
  }

  return [tab, setTab];
}
