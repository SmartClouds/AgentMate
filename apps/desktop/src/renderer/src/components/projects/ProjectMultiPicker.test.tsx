import type { Project } from '@agentmat/core';
import { screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ProjectMultiPicker } from './ProjectMultiPicker';

/**
 * Picking several projects: the chosen ones sit in the field as chips that can be removed, and the
 * list searches by name or folder and ticks rows on and off without closing.
 */

function project(overrides: Partial<Project>): Project {
  return {
    id: 'p1',
    name: 'Storefront',
    folderPath: 'C:\\work\\storefront',
    iconDataUrl: null,
    iconBgColor: null,
    iconColor: null,
    archived: false,
    ...overrides,
  } as Project;
}

const projects = [
  project({ id: 'p1', name: 'Storefront', folderPath: 'C:\\work\\storefront' }),
  project({ id: 'p2', name: 'Blog', folderPath: 'C:\\work\\blog' }),
  project({ id: 'p3', name: 'Old site', folderPath: 'C:\\work\\old', archived: true }),
];

function Harness({
  initial = [],
  onChange,
}: {
  initial?: string[];
  onChange?: (ids: string[]) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="picker">Projects</label>
      <ProjectMultiPicker
        id="picker"
        value={value}
        projects={projects}
        onChange={(ids) => {
          setValue(ids);
          onChange?.(ids);
        }}
      />
    </>
  );
}

function option(name: string): HTMLElement {
  return screen.getByRole('option', { name: new RegExp(name) });
}

describe('ProjectMultiPicker', () => {
  it('shows the chosen projects as chips and says when there are none', () => {
    const { unmount } = renderWithProviders(<Harness />);
    expect(screen.getByText('No projects attached')).toBeTruthy();
    unmount();

    renderWithProviders(<Harness initial={['p2']} />);
    expect(screen.getByRole('button', { name: 'Remove Blog' })).toBeTruthy();
    expect(screen.queryByText('No projects attached')).toBeNull();
  });

  it('is named by its label and ticks projects on and off without closing', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Projects' }));
    await user.click(option('Storefront'));
    expect(onChange).toHaveBeenLastCalledWith(['p1']);
    expect(option('Storefront').getAttribute('data-checked')).toBe('true');

    await user.click(option('Blog'));
    expect(onChange).toHaveBeenLastCalledWith(['p1', 'p2']);

    await user.click(option('Storefront'));
    expect(onChange).toHaveBeenLastCalledWith(['p2']);
    expect(option('Storefront').getAttribute('data-checked')).toBe('false');
  });

  it('searches by name and by folder, and leaves archived projects out', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole('combobox', { name: 'Projects' }));

    expect(screen.queryByRole('option', { name: /Old site/ })).toBeNull();
    const search = screen.getByPlaceholderText('Search projects…');
    await user.type(search, 'blog');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(option('Blog')).toBeTruthy();

    await user.clear(search);
    await user.type(search, 'storefront');
    expect(option('Storefront')).toBeTruthy();

    await user.clear(search);
    await user.type(search, 'nothing like it');
    expect(screen.getByText('No project matches.')).toBeTruthy();
  });

  it('keeps an archived project that is already attached, so its chip never vanishes', async () => {
    const { user } = renderWithProviders(<Harness initial={['p3']} />);

    expect(screen.getByRole('button', { name: 'Remove Old site' })).toBeTruthy();
    await user.click(screen.getByRole('combobox', { name: 'Projects' }));
    expect(option('Old site').getAttribute('data-checked')).toBe('true');
  });

  it('removes a project from its chip', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness initial={['p1', 'p2']} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Remove Storefront' }));

    expect(onChange).toHaveBeenLastCalledWith(['p2']);
    expect(screen.queryByRole('button', { name: 'Remove Storefront' })).toBeNull();
  });

  it('shows an id it does not know as a removable chip', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness initial={['gone']} onChange={onChange} />);

    expect(screen.getByText('Removed project')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remove Removed project' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('can be reached and opened from the keyboard', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<Harness onChange={onChange} />);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Projects' }));
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['p1']);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('takes an aria label when no visible label points at it', () => {
    renderWithProviders(
      <ProjectMultiPicker value={[]} onChange={vi.fn()} projects={projects} ariaLabel="Attach" />,
    );
    expect(screen.getByRole('combobox', { name: 'Attach' })).toBeTruthy();
  });
});
