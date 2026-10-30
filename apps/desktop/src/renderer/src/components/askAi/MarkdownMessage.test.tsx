import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { MarkdownMessage } from './MarkdownMessage';

const LONG = `/var/lib/docker/${'segment'.repeat(30)}`;
const WRAPS = '[overflow-wrap:anywhere]';

describe('MarkdownMessage', () => {
  it('wraps long words in paragraphs, list items and inline code instead of widening its box', () => {
    renderWithProviders(
      <MarkdownMessage content={`Para ${LONG}\n\n- item ${LONG}x\n\nSee \`${LONG}y\`.`} />,
    );
    expect(screen.getByText(`Para ${LONG}`, { exact: false }).closest('p')).toHaveClass(WRAPS);
    expect(screen.getByText(`item ${LONG}x`, { exact: false }).closest('li')).toHaveClass(WRAPS);
    expect(screen.getByText(`${LONG}y`)).toHaveClass('break-all');
  });

  it('lets a wide table scroll in its own box, never the page', () => {
    renderWithProviders(<MarkdownMessage content={'| a | b |\n|---|---|\n| 1 | 2 |'} />);
    const wrapper = screen.getByRole('table').parentElement;
    expect(wrapper).toHaveClass('overflow-x-auto', 'max-w-full');
  });

  it('wraps a code block rather than scrolling it sideways', () => {
    renderWithProviders(<MarkdownMessage content={'```sh\n' + `echo ${LONG}` + '\n```'} />);
    const block = screen.getByText(`echo ${LONG}`);
    expect(block).toHaveClass('whitespace-pre-wrap', WRAPS);
    expect(block).not.toHaveClass('overflow-x-auto');
  });
});
