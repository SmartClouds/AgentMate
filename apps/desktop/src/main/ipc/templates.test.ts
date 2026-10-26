import { readFileSync } from 'node:fs';
import type { PromptTemplate } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Saved prompt templates, stored as JSON under userData. Small handlers, but they are the only
 * writer of that file, so what is checked here is that a save survives a reload and that deleting
 * one leaves the rest alone.
 */

const userData = useTempUserData();
expectChannelsCovered(IPC.templates);

async function register(): Promise<void> {
  await loadIpc(
    () => import('./templates'),
    (module) => module.registerTemplateHandlers(),
  );
}

function onDisk(): PromptTemplate[] {
  return JSON.parse(readFileSync(userData.dataFile('templates.json'), 'utf-8'));
}

function input(name: string) {
  return { name, content: `Write ${name}`, promptType: 'Full Stack', targetAI: 'Claude Code' };
}

beforeEach(async () => {
  await register();
});

describe('templates', () => {
  it('starts empty on a fresh profile', async () => {
    await expect(invoke(IPC.templates.list)).resolves.toEqual([]);
  });

  it('saves a template with an id and a creation date, and hands it straight back', async () => {
    const saved = await invoke<PromptTemplate>(IPC.templates.save, input('login form'));

    expect(saved).toMatchObject({ name: 'login form', content: 'Write login form' });
    expect(saved.id).toMatch(/[0-9a-f-]{36}/);
    expect(Number.isNaN(Date.parse(saved.createdAt))).toBe(false);
    expect(onDisk()).toHaveLength(1);
  });

  it('puts the newest template first, which is the order the list is shown in', async () => {
    await invoke(IPC.templates.save, input('first'));
    await invoke(IPC.templates.save, input('second'));

    const listed = await invoke<PromptTemplate[]>(IPC.templates.list);
    expect(listed.map((one) => one.name)).toEqual(['second', 'first']);
  });

  it('reads back what a previous run wrote', async () => {
    const saved = await invoke<PromptTemplate>(IPC.templates.save, input('kept'));

    // A fresh registration stands in for the next start of the app.
    await register();

    await expect(invoke(IPC.templates.list)).resolves.toEqual([saved]);
  });

  it('deletes one template and leaves the others', async () => {
    const doomed = await invoke<PromptTemplate>(IPC.templates.save, input('doomed'));
    await invoke(IPC.templates.save, input('kept'));

    await invoke(IPC.templates.delete, doomed.id);

    const listed = await invoke<PromptTemplate[]>(IPC.templates.list);
    expect(listed.map((one) => one.name)).toEqual(['kept']);
    expect(onDisk()).toHaveLength(1);
  });

  it('does nothing for an id that is not there', async () => {
    await invoke(IPC.templates.save, input('kept'));

    // The renderer can ask twice, for example a double click on delete.
    await expect(invoke(IPC.templates.delete, 'no-such-id')).resolves.toBeUndefined();

    expect(await invoke<PromptTemplate[]>(IPC.templates.list)).toHaveLength(1);
  });
});
