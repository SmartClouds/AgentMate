import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type RenderHookOptions,
  type RenderHookResult,
  type RenderOptions,
  type RenderResult,
  render,
  renderHook,
} from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { type BridgeOverrides, type FakeBridge, installRunovaBridge } from './runovaBridge';

/**
 * Renders a page or component with the providers App.tsx wraps everything in, so tests exercise
 * the same query client, tooltips and router the app has.
 */

export interface ProviderOptions extends Omit<RenderOptions, 'wrapper'> {
  /** The entry in the router's history, for example `/projects/abc`. */
  route?: string;
  /** The route pattern, when the component reads params: `projects/:projectId`. */
  path?: string;
  /** Answers for `window.runova`, as dotted paths. */
  bridge?: BridgeOverrides;
  queryClient?: QueryClient;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // Retries turn one rejected call into a multi-second test, and a failed query is often
      // exactly what is being asserted on.
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** What a provider-wrapped render hands back: the usual queries plus the fakes it set up. */
export type ProviderRender = RenderResult & {
  user: UserEvent;
  bridge: FakeBridge;
  queryClient: QueryClient;
};

export function renderWithProviders(
  ui: ReactElement,
  options: ProviderOptions = {},
): ProviderRender {
  const {
    route = '/',
    path,
    bridge: overrides,
    queryClient = createQueryClient(),
    ...rest
  } = options;
  const bridge = installRunovaBridge(overrides);
  const user = userEvent.setup();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0} skipDelayDuration={0}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path ?? '*'} element={ui} />
            {/* Somewhere to land when the component navigates away, which otherwise renders the
                same nothing but logs "No routes matched location". */}
            {path ? <Route path="*" element={null} /> : null}
          </Routes>
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
    rest,
  );

  return { ...view, user, bridge, queryClient };
}

export interface HookProviderOptions<Props> extends Omit<RenderHookOptions<Props>, 'wrapper'> {
  route?: string;
  bridge?: BridgeOverrides;
  queryClient?: QueryClient;
}

export function renderHookWithProviders<Result, Props>(
  hook: (props: Props) => Result,
  options: HookProviderOptions<Props> = {},
): RenderHookResult<Result, Props> & { bridge: FakeBridge; queryClient: QueryClient } {
  const { route = '/', bridge: overrides, queryClient = createQueryClient(), ...rest } = options;
  const bridge: FakeBridge = installRunovaBridge(overrides);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={0}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );

  return { ...renderHook(hook, { wrapper, ...rest }), bridge, queryClient };
}

export { userEvent };
