// @vitest-environment jsdom
import type { CliLaunchOptions } from '@runova/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EffortPicker } from './RunSettingsFields';

/**
 * Synthetic options, so the disabled states don't depend on which models the catalog happens to
 * restrict. One model takes only some efforts, and one has no effort setting at all.
 */
const options: CliLaunchOptions = {
  cliId: 'test-cli',
  modelFlag: '--model',
  models: [
    { value: 'lite', label: 'Lite', efforts: ['low', 'medium'] },
    { value: 'plain', label: 'Plain' },
  ],
  efforts: ['low', 'medium', 'high'],
  modes: [],
  modeFlags: [],
};

describe('EffortPicker', () => {
  it('disables the levels the chosen model cannot use', () => {
    render(<EffortPicker options={options} model="lite" value="low" onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Low' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'High' })).toBeDisabled();
  });

  it('disables every level when the model has no effort setting', () => {
    render(<EffortPicker options={options} model="plain" value={undefined} onChange={vi.fn()} />);

    for (const name of ['Not set', 'Low', 'Medium', 'High']) {
      expect(screen.getByRole('radio', { name })).toBeDisabled();
    }
  });
});
