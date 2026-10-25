import type { GithubRunAnnotation } from '@shared/apiTypes';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RunAnnotations } from './RunAnnotations';

const run = {
  id: 100,
  repo: 'acme/app',
  status: 'completed',
  displayTitle: 'Add login',
  workflowName: 'CI',
  runNumber: 7,
  headBranch: 'main',
} as const;

const annotations: GithubRunAnnotation[] = [
  {
    level: 'failure',
    jobName: 'test',
    path: 'src/a.ts',
    startLine: 3,
    endLine: null,
    title: '',
    message: 'type error',
  },
  {
    level: 'warning',
    jobName: 'build',
    path: '.github',
    startLine: null,
    endLine: null,
    title: 'Deprecated',
    message: 'node 18 is old',
  },
];
const counts = { failure: 1, warning: 1, notice: 0 };

describe('RunAnnotations', () => {
  it('says what the run left behind and opens to the list', async () => {
    const { user } = renderWithProviders(
      <RunAnnotations run={run} annotations={annotations} counts={counts} />,
    );
    expect(screen.queryByText('type error')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /1 error · 1 warning/ }));

    expect(screen.getByText('type error')).toBeInTheDocument();
    expect(screen.getByText('src/a.ts:3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy all' })).toBeInTheDocument();
  });

  it('renders nothing when there are no annotations', () => {
    const { container } = renderWithProviders(
      <RunAnnotations run={run} annotations={[]} counts={{ failure: 0, warning: 0, notice: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lines up under a run card by default, and sits flush when asked', () => {
    const indented = renderWithProviders(
      <RunAnnotations run={run} annotations={annotations} counts={counts} />,
    );
    expect(indented.container.firstElementChild?.className).toContain('pl-[3.125rem]');
    indented.unmount();

    const flush = renderWithProviders(
      <RunAnnotations run={run} annotations={annotations} counts={counts} flush />,
    );
    expect(flush.container.firstElementChild?.className).not.toContain('pl-[3.125rem]');
  });
});
