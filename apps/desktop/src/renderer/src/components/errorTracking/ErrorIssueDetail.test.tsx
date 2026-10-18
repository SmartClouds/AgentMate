import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { detail, event, exception, frame, issue, NOW, project } from './testing/fixtures';

vi.mock('@/lib/workspace/launch', () => ({
  launchPromptTab: vi.fn(() => 'tab-1'),
  projectCliId: () => 'claude-code',
}));
vi.mock('@/components/promptBuilder/RunRecommendation', () => ({
  useRunRecommendation: () => ({
    status: 'idle',
    recommendation: null,
    choice: null,
    analyze: vi.fn(),
  }),
  RunRecommendationPanel: () => <div>sizing panel</div>,
}));
const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast }));

const { ErrorIssueDetail } = await import('./ErrorIssueDetail');

const TITLE = "TypeError: Cannot read properties of undefined (reading 'total')";
const onClose = vi.fn();

function renderPanel(bridge: Record<string, unknown> = {}) {
  return renderWithProviders(
    <ErrorIssueDetail
      issueRef={{ connectionId: 'c1', issueId: '4501' }}
      onClose={onClose}
      projects={[project()]}
      now={NOW}
    />,
    { bridge: { 'errorTracking.getIssue': async () => detail(), ...bridge } },
  );
}

async function panel() {
  return screen.findByRole('dialog', { name: TITLE });
}

describe('ErrorIssueDetail', () => {
  it('shows the level, status and the numbers', async () => {
    renderPanel();
    const view = await panel();
    expect(view).toHaveTextContent('WEB-3F');
    expect(view).toHaveTextContent('checkout/summary.ts in computeTotal');
    expect(view).toHaveTextContent('Unresolved');
    const stats = within(view).getByRole('group', { name: 'Issue numbers' });
    expect(stats).toHaveTextContent('Events');
    expect(stats).toHaveTextContent('1,240');
    expect(stats).toHaveTextContent('Users');
    expect(stats).toHaveTextContent('87');
    expect(stats).toHaveTextContent('First seen');
    expect(stats).toHaveTextContent('3 days ago');
    expect(stats).toHaveTextContent('Last seen');
    expect(stats).toHaveTextContent('2 min ago');
  });

  it('puts the throwing frame first with its code, and folds the library frames', async () => {
    const { user } = renderPanel();
    const view = await panel();
    const trace = within(view).getByRole('region', { name: 'Stack trace' });
    const frames = within(trace).getAllByTestId('frame');
    expect(frames[0]).toHaveTextContent('src/checkout/summary.ts');
    expect(frames[0]).toHaveTextContent('computeTotal');
    const current = frames[0].querySelector('[data-current="true"]');
    expect(current).toHaveTextContent('return lines.total + cart.shipping;');
    expect(trace).not.toHaveTextContent('react-dom.js');

    await user.click(within(trace).getByRole('button', { name: 'Show 2 library frames' }));
    expect(trace).toHaveTextContent('node_modules/react-dom/cjs/react-dom.js');
  });

  it('shows a chained exception as the cause, after the thrown one', async () => {
    renderPanel({
      'errorTracking.getIssue': async () =>
        detail({
          event: event({
            exceptions: [
              exception({
                type: 'ECONNRESET',
                value: 'socket hang up',
                frames: [frame({ filename: 'src/db.ts' })],
              }),
              exception(),
            ],
          }),
        }),
    });
    const trace = within(await panel()).getByRole('region', { name: 'Stack trace' });
    const blocks = within(trace).getAllByTestId('exception');
    expect(blocks[0]).toHaveTextContent('TypeError');
    expect(blocks[1]).toHaveTextContent('Caused by');
    expect(blocks[1]).toHaveTextContent('ECONNRESET');
    expect(blocks[1]).toHaveTextContent('socket hang up');
  });

  it('shows the breadcrumbs, the request and the tags', async () => {
    renderPanel();
    const view = await panel();
    const crumbs = within(view).getByRole('list', { name: 'Breadcrumbs' });
    expect(within(crumbs).getAllByRole('listitem')).toHaveLength(2);
    expect(crumbs).toHaveTextContent('GET /api/cart [500]');
    expect(within(view).getByRole('region', { name: 'Request' })).toHaveTextContent(
      'GET https://shop.example.com/checkout?step=***',
    );
    const tags = within(view).getByRole('region', { name: 'Tags' });
    expect(tags).toHaveTextContent('browser');
    expect(tags).toHaveTextContent('Chrome 129');
  });

  it('resolves at once and offers an undo', async () => {
    const { user, bridge } = renderPanel({
      'errorTracking.setIssueStatus': async () => issue({ status: 'resolved' }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Resolve' }));
    await waitFor(() =>
      expect(bridge.$fn('errorTracking.setIssueStatus')).toHaveBeenCalledWith({
        connectionId: 'c1',
        issueId: '4501',
        status: 'resolved',
        ignoreMinutes: null,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith(
      'Issue resolved',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
    );
  });

  it('ignores for an hour from the menu', async () => {
    const { user, bridge } = renderPanel({
      'errorTracking.setIssueStatus': async () => issue({ status: 'ignored' }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Ignore' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ignore for 1 hour' }));
    await waitFor(() =>
      expect(bridge.$fn('errorTracking.setIssueStatus')).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ignored', ignoreMinutes: 60 }),
      ),
    );
  });

  it('turns the change back and says why when it fails', async () => {
    let fail: () => void = () => undefined;
    const { user } = renderPanel({
      'errorTracking.setIssueStatus': () =>
        new Promise((_resolve, reject) => {
          fail = () => reject(new Error('Token rejected'));
        }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Resolve' }));
    await waitFor(() => expect(view).toHaveTextContent('Resolved'));
    fail();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Could not resolve the issue',
        expect.objectContaining({ description: 'Token rejected' }),
      ),
    );
    expect(view).toHaveTextContent('Unresolved');
  });

  it('turns Resolve and Ignore off and names the scope when the token cannot write', async () => {
    const { user } = renderPanel({
      'errorTracking.getIssue': async () => detail({ canWrite: false }),
    });
    const view = await panel();
    const resolve = within(view).getByRole('button', { name: 'Resolve' });
    expect(resolve).toBeDisabled();
    expect(within(view).getByRole('button', { name: 'Ignore' })).toBeDisabled();
    await user.hover(resolve.parentElement as HTMLElement);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('event:write');
    expect(view.querySelector('[title]')).toBeNull();
  });

  it('copies the AI-ready prompt', async () => {
    const { user } = renderPanel({
      'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F please.', copy: 'plain' }),
    });
    const view = await panel();
    await user.click(within(view).getByRole('button', { name: 'Copy for AI' }));
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('Fix WEB-3F please.'),
    );
  });

  it('opens Fix with AI and links to Sentry', async () => {
    const { user } = renderPanel({
      'errorTracking.fixPrompt': async () => ({ prompt: 'Fix WEB-3F please.', copy: 'plain' }),
    });
    const view = await panel();
    expect(within(view).getByRole('link', { name: 'Open in Sentry' })).toHaveAttribute(
      'href',
      'https://acme.sentry.io/issues/4501/',
    );
    await user.click(within(view).getByRole('button', { name: 'Fix with AI' }));
    expect(await screen.findByRole('dialog', { name: 'Fix WEB-3F with AI' })).toBeInTheDocument();
  });

  it('says so when the issue cannot be read', async () => {
    renderPanel({
      'errorTracking.getIssue': async () => {
        throw new Error('Not found');
      },
    });
    expect(await screen.findByText('Could not load this issue')).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
  });
});
