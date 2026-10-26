import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { CustomDesktopPet } from '@runova/core';
import { app, dialog } from 'electron';
import { store } from '../store';
import { petManager } from './petWindow';

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['.png', '.gif', '.webp']);

function petsDir(): string {
  return join(app.getPath('userData'), 'pets');
}

function mimeForExt(ext: string): string {
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  return 'image/webp';
}

function looksLikeImage(buf: Buffer, ext: string): boolean {
  if (ext === '.png')
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (ext === '.gif') return buf.toString('ascii', 0, 3) === 'GIF';
  if (ext === '.webp') {
    return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function nameFromPath(filePath: string): string {
  const stem = basename(filePath, extname(filePath))
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!stem) return 'My pet';
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function petFilePath(fileName: string): string {
  return join(petsDir(), basename(fileName));
}

export async function importCustomPet(): Promise<CustomDesktopPet | null> {
  const picked = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Pet image', extensions: ['png', 'gif', 'webp'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;

  const src = picked.filePaths[0];
  const ext = extname(src).toLowerCase();
  if (!ALLOWED.has(ext)) throw new Error('Use a PNG, GIF, or WebP image.');

  const buf = await readFile(src);
  if (buf.byteLength > MAX_BYTES) throw new Error('That image is larger than 8 MB.');
  if (!looksLikeImage(buf, ext))
    throw new Error('That file does not look like a PNG, GIF, or WebP.');

  const id = `custom-${randomUUID()}`;
  const fileName = `${id}${ext}`;
  await mkdir(petsDir(), { recursive: true });
  await writeFile(petFilePath(fileName), buf);

  const pet: CustomDesktopPet = { id, name: nameFromPath(src), fileName };
  await store.updateSettings((settings) => ({
    ...settings,
    desktopPetCustoms: [...settings.desktopPetCustoms, pet],
    desktopPetCharacterId: id,
  }));
  void petManager.syncFromSettings();
  return pet;
}

export async function removeCustomPet(id: string): Promise<void> {
  const settings = await store.getSettings();
  const found = settings.desktopPetCustoms.find((pet) => pet.id === id);
  if (!found) return;
  await unlink(petFilePath(found.fileName)).catch(() => undefined);
  await store.updateSettings((latest) => ({
    ...latest,
    desktopPetCustoms: latest.desktopPetCustoms.filter((pet) => pet.id !== id),
    desktopPetCharacterId:
      latest.desktopPetCharacterId === id ? 'fandi' : latest.desktopPetCharacterId,
  }));
  void petManager.syncFromSettings();
}

export async function customPetDataUrls(): Promise<Record<string, string>> {
  const settings = await store.getSettings();
  const urls: Record<string, string> = {};
  for (const pet of settings.desktopPetCustoms) {
    try {
      const buf = await readFile(petFilePath(pet.fileName));
      const ext = extname(pet.fileName).toLowerCase();
      urls[pet.id] = `data:${mimeForExt(ext)};base64,${buf.toString('base64')}`;
    } catch {
      // Missing file: skip so the picker still loads the rest.
    }
  }
  return urls;
}
