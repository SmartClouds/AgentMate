import { randomUUID } from 'node:crypto';
import {
  buildHealthDiagnosePrompt,
  type HealthDiagnosis,
  type HealthIncident,
  redactHealthText,
} from '@runova/core';
import {
  cancelHeadlessPrompt,
  type HeadlessPromptOptions,
  type HeadlessPromptResult,
  runHeadlessCliPrompt,
} from '../cli/headlessPrompt';
import { store } from '../store';
import { broadcastHealthChanged, mutateHealth, readHealthState } from './store';

/**
 * The read-only AI analysis of a healthcheck incident (E22). When an incident opens on a target
 * that asks for it, the project's agent CLI reads the redacted report in the project folder and
 * says what it thinks is wrong. It never gets write access. It runs once per incident, and at
 * most once in ten minutes per target on its own, so a flapping target cannot keep an agent busy.
 * The user can start it for any incident, and stop it.
 */

export interface HealthDiagnoseDeps {
  run: (
    prompt: string,
    cwd: string,
    options: HeadlessPromptOptions,
  ) => Promise<HeadlessPromptResult>;
  cancel: (requestId: string) => void;
  now?: () => number;
  changed?: (targetIds: string[]) => void;
}

const DIAGNOSE_TIMEOUT_MS = 180_000;
const AUTO_DEBOUNCE_MS = 10 * 60_000;
const MAX_TEXT = 20_000;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n(trimmed)` : text;
}

function finished(
  started: HealthDiagnosis,
  result: HeadlessPromptResult,
  at: number,
): HealthDiagnosis {
  const base = { ...started, finishedAt: at, cliName: result.cliName };
  if (result.cancelled) return { ...base, status: 'cancelled', text: null };
  const answer = result.text.trim();
  if (result.ok && answer) return { ...base, status: 'done', text: clip(redactHealthText(answer)) };
  const why = result.ok ? `${result.cliName ?? 'The CLI'} finished with no answer.` : result.error;
  return {
    ...base,
    status: 'failed',
    text: clip(redactHealthText(why || 'The analysis failed.')),
  };
}

export function createHealthDiagnoser(deps: HealthDiagnoseDeps) {
  const now = deps.now ?? Date.now;
  const changed = deps.changed ?? broadcastHealthChanged;
  /** By target id: the run going now. */
  const running = new Map<string, { requestId: string; incidentId: string }>();
  /** By target id: when the last run started, for the automatic debounce. */
  const lastStarted = new Map<string, number>();
  const work = new Set<Promise<void>>();

  function setDiagnosis(targetId: string, incidentId: string, diagnosis: HealthDiagnosis) {
    return mutateHealth((state) => {
      const incident = state.results[targetId]?.incidents.find((one) => one.id === incidentId);
      if (!incident) return false;
      incident.diagnosis = diagnosis;
      return true;
    });
  }

  /** Records the run as started and lets it finish in the background. */
  async function start(targetId: string, pick: (incidents: HealthIncident[]) => string | null) {
    if (running.has(targetId)) return;
    const { targets, results } = await readHealthState();
    const target = targets.find((one) => one.id === targetId);
    const result = results[targetId];
    const incidentId = result ? pick(result.incidents) : null;
    if (!target || !result?.report || !incidentId) return;
    const project = (await store.getProjects()).find((one) => one.id === target.projectId);
    if (!project) return;
    const environment = target.environmentId
      ? (await store.getProjectEnvironments()).find((one) => one.id === target.environmentId)
      : undefined;

    const prompt = buildHealthDiagnosePrompt({
      projectName: project.name,
      targetName: target.name,
      environmentName: environment?.name ?? null,
      serverLabel: target.serverLabel,
      url: target.url,
      report: result.report,
    });
    const requestId = `health-${randomUUID()}`;
    const startedAt = now();
    const diagnosis: HealthDiagnosis = {
      status: 'running',
      startedAt,
      finishedAt: null,
      cliName: null,
      text: null,
    };
    running.set(targetId, { requestId, incidentId });
    lastStarted.set(targetId, startedAt);
    await setDiagnosis(targetId, incidentId, diagnosis);
    changed([targetId]);

    const job = (async () => {
      let outcome: HeadlessPromptResult;
      try {
        outcome = await deps.run(prompt, project.folderPath, {
          requestId,
          preferredCliId: project.cliId,
          allowWrites: false,
          timeoutMs: DIAGNOSE_TIMEOUT_MS,
        });
      } catch (error) {
        outcome = {
          ok: false,
          text: '',
          cliName: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        if (await setDiagnosis(targetId, incidentId, finished(diagnosis, outcome, now()))) {
          changed([targetId]);
        }
      } finally {
        running.delete(targetId);
      }
    })();
    work.add(job);
    void job.finally(() => work.delete(job));
  }

  return {
    /** Called by the scheduler when an incident opens. */
    async onIncidentOpened(targetId: string, incidentId: string): Promise<void> {
      const { targets, results } = await readHealthState();
      const target = targets.find((one) => one.id === targetId);
      const incident = results[targetId]?.incidents.find((one) => one.id === incidentId);
      if (!target?.autoDiagnose || !incident || incident.diagnosis !== null) return;
      const last = lastStarted.get(targetId);
      if (last !== undefined && now() - last < AUTO_DEBOUNCE_MS) {
        const at = now();
        await setDiagnosis(targetId, incidentId, {
          status: 'skipped',
          startedAt: at,
          finishedAt: at,
          cliName: null,
          text: 'An analysis of this target ran less than 10 minutes ago, so this one was skipped. Start it from the incident if you need it.',
        });
        changed([targetId]);
        return;
      }
      await start(targetId, () => incidentId);
    },

    /** Starts the analysis of the open incident, or the latest one, whatever the target says. */
    async diagnoseNow(targetId: string): Promise<void> {
      const { targets, results } = await readHealthState();
      if (!targets.some((one) => one.id === targetId)) {
        throw new Error('That healthcheck no longer exists.');
      }
      const incidents = results[targetId]?.incidents ?? [];
      if (incidents.length === 0 || !results[targetId]?.report) {
        throw new Error('This target has not failed yet, so there is nothing to analyze.');
      }
      await start(
        targetId,
        (list) => (list.find((one) => one.resolvedAt === null) ?? list[0])?.id ?? null,
      );
    },

    cancel(targetId: string): void {
      const run = running.get(targetId);
      if (run) deps.cancel(run.requestId);
    },

    /** Resolves once every run started so far has finished and been recorded. */
    async idle(): Promise<void> {
      while (work.size > 0) await Promise.all([...work]);
    },
  };
}

export type HealthDiagnoser = ReturnType<typeof createHealthDiagnoser>;

export const healthDiagnoser = createHealthDiagnoser({
  run: runHeadlessCliPrompt,
  cancel: (requestId) => {
    cancelHeadlessPrompt(requestId);
  },
});
