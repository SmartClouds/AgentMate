import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { ServerSections, sectionFromView } from './ServerSections';

/** The pill strip of a Deploy server's sections, and how the page address picks one. */

describe('ServerSections', () => {
  it('lists Files right after Containers', () => {
    renderWithProviders(<ServerSections value="overview" onChange={vi.fn()} />);
    const strip = screen.getByRole('navigation', { name: 'Server sections' });
    const names = within(strip)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.indexOf('Files')).toBe(names.indexOf('Containers') + 1);
  });

  it('switches to Files', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<ServerSections value="overview" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Files' }));
    expect(onChange).toHaveBeenCalledWith('files');
  });
});

describe('ServerSections backups', () => {
  it('lists Backups before Security and switches to it (E28)', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<ServerSections value="overview" onChange={onChange} />);
    const names = within(screen.getByRole('navigation', { name: 'Server sections' }))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.indexOf('Backups')).toBe(names.indexOf('Security') - 1);
    await user.click(screen.getByRole('button', { name: 'Backups' }));
    expect(onChange).toHaveBeenCalledWith('backups');
    expect(sectionFromView('backups')).toBe('backups');
  });
});

describe('ServerSections notifications', () => {
  it('lists Notifications last, after Security, and switches to it (E30)', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<ServerSections value="overview" onChange={onChange} />);
    const names = within(screen.getByRole('navigation', { name: 'Server sections' }))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.at(-1)).toBe('Notifications');
    expect(names.indexOf('Notifications')).toBe(names.indexOf('Security') + 1);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));
    expect(onChange).toHaveBeenCalledWith('notifications');
    expect(sectionFromView('notifications')).toBe('notifications');
  });
});

describe('ServerSections cleanup', () => {
  it('lists Cleanup right after Files and switches to it', async () => {
    const onChange = vi.fn();
    const { user } = renderWithProviders(<ServerSections value="overview" onChange={onChange} />);
    const names = within(screen.getByRole('navigation', { name: 'Server sections' }))
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(names.indexOf('Cleanup')).toBe(names.indexOf('Files') + 1);
    await user.click(screen.getByRole('button', { name: 'Cleanup' }));
    expect(onChange).toHaveBeenCalledWith('cleanup');
    expect(sectionFromView('cleanup')).toBe('cleanup');
  });
});

describe('sectionFromView', () => {
  it('reads files, and falls back to the Overview for anything else', () => {
    expect(sectionFromView('files')).toBe('files');
    expect(sectionFromView('nope')).toBe('overview');
    expect(sectionFromView(null)).toBe('overview');
  });
});
