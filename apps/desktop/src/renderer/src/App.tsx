import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Toaster, toast } from 'sonner';
import { ConfirmDialogHost } from './components/ConfirmDialog';
import { StopContainersDialogHost } from './components/docker/StopContainersDialog';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WritingMenuHost } from './components/grammar/WritingMenuHost';
import { AppShell } from './components/layout/AppShell';
import DesktopPetRoute from './components/pet/DesktopPetRoute';
import PromptBuildWidgetRoute from './components/projects/PromptBuildWidgetRoute';
import { RunProposalHost } from './components/projects/RunProposalHost';
import { QuitConfirmation } from './components/QuitConfirmation';
import { RelayBoardHost } from './components/relay/RelayBoard';
import { RelayProposalHost } from './components/relay/RelayProposalHost';
import { HostKeyChangedDialogHost } from './components/remote/HostKeyChangedDialog';
import RemoteSessionRoute from './components/remote/RemoteSessionRoute';
import { ImageViewerHost } from './components/terminal/ImageViewerHost';
import { UpdateManager } from './components/UpdateManager';
import { TooltipProvider } from './components/ui/tooltip';
import WidgetRoute from './components/usage/WidgetRoute';
import WorkspaceRoute from './components/workspace/WorkspaceRoute';
import { useIsDarkMode } from './lib/chartColors';
import { installToastHistoryCapture } from './lib/toastHistory';
import AndroidPage from './pages/AndroidPage';
import AskAiPage from './pages/AskAiPage';
import CliManagerPage from './pages/CliManagerPage';
import DashboardPage from './pages/DashboardPage';
import DockerPage from './pages/DockerPage';
import HelpPage from './pages/HelpPage';
import McpPage from './pages/McpPage';
import PipelinesPage from './pages/PipelinesPage';
import ProjectDetailPage from './pages/ProjectDetailPage';
import ProjectsPage from './pages/ProjectsPage';
import PromptBuilderPage from './pages/PromptBuilderPage';
import PromptHistoryPage from './pages/PromptHistoryPage';
import RemoteFileManagerPage from './pages/RemoteFileManagerPage';
import RemotePage from './pages/RemotePage';
import SettingsPage from './pages/SettingsPage';
import ToolsPage from './pages/ToolsPage';
import UsagePage from './pages/UsagePage';
import VaultPage from './pages/VaultPage';
import { queryClient } from './queryClient';
import { initDefaultCli } from './stores/cliStore';
import { initDashboardLayout } from './stores/dashboardLayoutStore';
import { initPingTargets } from './stores/pingTargetsStore';
import { initRemote } from './stores/remoteStore';
import { initTerminalAppearance } from './stores/terminalAppearanceStore';
import { initTheme } from './stores/themeStore';
import { initUpdateStatusListener } from './stores/updateStore';

installToastHistoryCapture();

/** Skills ships a large offline catalog; keep it out of the main chunk until this route opens. */
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const ApiClientPage = lazy(() => import('./pages/ApiClientPage'));
/** Deploy is a large section that most sessions never open, so it loads on first visit. */
const DeployPage = lazy(() => import('./pages/DeployPage'));
/** Health checks (E22) load on first visit, like Deploy. */
const HealthPage = lazy(() => import('./pages/HealthPage'));
/** Carries the IronRDP WebAssembly engine, which only Remote Desktop session windows need. */
const RdpSessionRoute = lazy(() => import('./components/rdp/RdpSessionRoute'));
/** The SFTP file manager for saved SSH servers (E25), loaded on first visit. */
const SshFilesPage = lazy(() => import('./pages/SshFilesPage'));
/** The same file manager popped out into a window of its own. */
const SftpWindowRoute = lazy(() => import('./components/sftp/SftpWindowRoute'));

/* Glass toasts: richColors is off on purpose. It paints an opaque per-type
   background that would defeat the frosted surface. The type accents live in
   index.css under .toaster-glass instead. */
function AppToaster(): React.JSX.Element {
  const isDark = useIsDarkMode();
  return (
    <Toaster
      theme={isDark ? 'dark' : 'light'}
      className="toaster-glass"
      position="bottom-right"
      gap={12}
      closeButton
    />
  );
}

function isStandalonePath(pathname: string): boolean {
  return (
    pathname.startsWith('/widget') ||
    pathname === '/desktop-pet' ||
    pathname === '/remote-session' ||
    pathname === '/rdp-session' ||
    pathname === '/sftp-window'
  );
}

function AppChrome(): React.JSX.Element | null {
  const { pathname } = useLocation();
  if (isStandalonePath(pathname)) return null;
  return (
    <>
      <AppToaster />
      <ConfirmDialogHost />
      <RunProposalHost />
      <RelayBoardHost />
      <RelayProposalHost />
      <StopContainersDialogHost />
      <HostKeyChangedDialogHost />
      <QuitConfirmation />
      <ImageViewerHost />
      <UpdateManager />
    </>
  );
}

export default function App(): React.JSX.Element {
  useEffect(() => {
    void initTheme();
    void initDefaultCli();
    void initTerminalAppearance();
    void initPingTargets();
    void initDashboardLayout();
    initRemote();
    // Usage threshold alerts prefer an OS notification; main only falls back
    // to this event when the platform has none to show. The OS notification's own
    // click already opens Usage there, so this toast gets the same shortcut.
    const unsubscribeThresholdAlert = window.agentmat.usage.onThresholdAlert(
      ({ title, body, providerId }) => {
        toast.warning(title, {
          description: body,
          action: {
            label: 'View',
            onClick: () => {
              window.location.hash = `#/usage?provider=${encodeURIComponent(providerId)}`;
            },
          },
        });
      },
    );
    const unsubscribeUpdateStatus = initUpdateStatusListener();
    return () => {
      unsubscribeThresholdAlert();
      unsubscribeUpdateStatus();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        {/* Outermost net: covers the shell itself and the standalone widget
            windows, so no failure can leave the window blank. */}
        <ErrorBoundary>
          <HashRouter>
            <Routes>
              {/* Floating desktop widget windows render standalone, outside the app shell. */}
              <Route path="widget/:id" element={<WidgetRoute />} />
              <Route path="widget/prompt-build/:id" element={<PromptBuildWidgetRoute />} />
              <Route path="desktop-pet" element={<DesktopPetRoute />} />
              <Route path="remote-session" element={<RemoteSessionRoute />} />
              <Route
                path="rdp-session"
                element={
                  <Suspense fallback={<div className="h-screen w-screen bg-background" />}>
                    <RdpSessionRoute />
                  </Suspense>
                }
              />
              <Route
                path="sftp-window"
                element={
                  <Suspense fallback={<div className="h-screen w-screen bg-background" />}>
                    <SftpWindowRoute />
                  </Suspense>
                }
              />
              <Route element={<AppShell />}>
                <Route index element={<DashboardPage />} />
                <Route path="cli-manager" element={<CliManagerPage />} />
                <Route path="prompt-builder" element={<PromptBuilderPage />} />
                <Route path="prompt-history" element={<PromptHistoryPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="projects/:projectId" element={<ProjectDetailPage />} />
                <Route path="workspace" element={<WorkspaceRoute />} />
                <Route path="workspace/:projectId" element={<WorkspaceRoute />} />
                <Route path="pipelines" element={<PipelinesPage />} />
                <Route path="notifications" element={<Navigate to="/pipelines" replace />} />
                <Route
                  path="deploy"
                  element={
                    <Suspense
                      fallback={
                        <div className="p-6 text-sm text-muted-foreground">Loading Deploy…</div>
                      }
                    >
                      <DeployPage />
                    </Suspense>
                  }
                />
                <Route
                  path="monitoring"
                  element={
                    <Suspense
                      fallback={
                        <div className="p-6 text-sm text-muted-foreground">Loading Monitoring…</div>
                      }
                    >
                      <HealthPage />
                    </Suspense>
                  }
                />
                <Route
                  path="deploy/cloudflare"
                  element={<Navigate to="/deploy?dialog=cloudflare" replace />}
                />
                <Route
                  path="skills"
                  element={
                    <Suspense
                      fallback={
                        <div className="p-6 text-sm text-muted-foreground">Loading skills…</div>
                      }
                    >
                      <SkillsPage />
                    </Suspense>
                  }
                />
                <Route
                  path="api-client"
                  element={
                    <Suspense
                      fallback={
                        <div className="p-6 text-sm text-muted-foreground">Loading API Client…</div>
                      }
                    >
                      <ApiClientPage />
                    </Suspense>
                  }
                />
                <Route path="mcp" element={<McpPage />} />
                <Route path="tools" element={<ToolsPage />} />
                <Route path="docker" element={<DockerPage />} />
                <Route path="android" element={<AndroidPage />} />
                <Route path="vault" element={<VaultPage />} />
                <Route path="usage" element={<UsagePage />} />
                <Route path="ask-ai" element={<AskAiPage />} />
                <Route path="remote" element={<RemotePage />} />
                <Route path="remote-files" element={<RemoteFileManagerPage />} />
                <Route
                  path="ssh-files/:serverId"
                  element={
                    <Suspense
                      fallback={
                        <div className="p-6 text-sm text-muted-foreground">Loading files…</div>
                      }
                    >
                      <SshFilesPage />
                    </Suspense>
                  }
                />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="help" element={<HelpPage />} />
                <Route path="help/:slug" element={<HelpPage />} />
              </Route>
            </Routes>
            <AppChrome />
            {/* Outside AppChrome on purpose: the standalone widget windows have
                text boxes too, and they should get the same writing menu. */}
            <WritingMenuHost />
          </HashRouter>
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
