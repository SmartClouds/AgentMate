import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { app } from 'electron';
import { asArray, runPowerShellJson } from './processTree';

const execFileAsync = promisify(execFile);

/** One row of a busiest-apps list: its name and the pids grouped under it, heaviest first. */
export interface AppIconRequest {
  name: string;
  pids: number[];
}

// A group like svchost or chrome can hold a hundred pids. The first few are plenty to find its exe.
const MAX_PIDS_PER_APP = 8;
// The lists refresh every few seconds and pids come and go, so the caches start over past this.
// Both go together: a remembered path is only useful while its icon is remembered too.
const CACHE_LIMIT = 2000;

/** Icon data URL by lowercased exe path. Null when the exe has no icon we could read. */
const iconByPath = new Map<string, string | null>();
/** Exe path by `pid:name`. Null when Windows would not tell us. The name guards against pid reuse. */
const pathByProcess = new Map<string, string | null>();

function isSafePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && pid < 2 ** 31;
}

function processKey(pid: number, name: string): string {
  return `${pid}:${name.toLowerCase()}`;
}

function remember<V>(cache: Map<string, V>, key: string, value: V): void {
  if (iconByPath.size + pathByProcess.size >= CACHE_LIMIT) {
    iconByPath.clear();
    pathByProcess.clear();
  }
  cache.set(key, value);
}

/**
 * Electron's app.getFileIcon hands back the blank "program" icon for plenty of exes that do have
 * one (Runova's own, the Claude Code CLI, the Visual Studio installer's helpers), so on Windows the
 * shell extracts it instead. Get-Process has no path for services and elevated processes, which
 * the service table and System32 cover. Names arrive base64 encoded, so nothing in a process name
 * can end up as script.
 */
function windowsIconScript(processes: { pid: number; name: string }[]): string {
  const names = Buffer.from(JSON.stringify(processes.map((p) => p.name)), 'utf8').toString(
    'base64',
  );
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$wanted = @(${processes.map((p) => p.pid).join(',')})
# Windows PowerShell's ConvertFrom-Json emits an array as one object, so ForEach-Object unrolls it.
$names = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${names}')) | ConvertFrom-Json | ForEach-Object { $_ })
$paths = @{}
foreach ($proc in @(Get-Process -Id $wanted)) {
  if ($proc.Path) { $paths[[int]$proc.Id] = $proc.Path }
}
$missing = @($wanted | Where-Object { -not $paths.ContainsKey([int]$_) })
if ($missing.Count -gt 0) {
  $filter = ($missing | ForEach-Object { "ProcessId=$_" }) -join ' OR '
  foreach ($service in @(Get-CimInstance Win32_Service -Filter $filter -Property ProcessId,PathName)) {
    $command = $service.PathName
    if ($paths.ContainsKey([int]$service.ProcessId)) { continue }
    if ($command -match '^\\s*"([^"]+)"' -or $command -match '^\\s*(.+?\\.exe)(\\s|$)') {
      $paths[[int]$service.ProcessId] = $Matches[1]
    }
  }
}
$rows = @()
$icons = @{}
for ($i = 0; $i -lt $wanted.Count; $i++) {
  $id = [int]$wanted[$i]
  $path = $paths[$id]
  if (-not $path) {
    $system = Join-Path $env:SystemRoot ('System32\\' + $names[$i] + '.exe')
    if (Test-Path -LiteralPath $system) { $path = $system }
  }
  $rows += [PSCustomObject]@{ pid = $id; path = $path }
  if ($path -and -not $icons.ContainsKey($path)) {
    $icons[$path] = $null
    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
    if ($icon) {
      $stream = New-Object IO.MemoryStream
      $icon.ToBitmap().Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      $icons[$path] = [Convert]::ToBase64String($stream.ToArray())
    }
  }
}
$iconRows = @($icons.GetEnumerator() | ForEach-Object { [PSCustomObject]@{ path = $_.Key; png = $_.Value } })
@{ processes = $rows; icons = $iconRows } | ConvertTo-Json -Compress -Depth 3
`;
}

interface WindowsIconAnswer {
  processes?: { pid: number; path: string | null }[] | { pid: number; path: string | null };
  icons?: { path: string; png: string | null }[] | { path: string; png: string | null };
}

function candidates(request: AppIconRequest): number[] {
  return request.pids.filter(isSafePid).slice(0, MAX_PIDS_PER_APP);
}

function cachedPath(request: AppIconRequest): string | null | undefined {
  let allKnown = true;
  for (const pid of candidates(request)) {
    const path = pathByProcess.get(processKey(pid, request.name));
    if (path) return path;
    if (path === undefined) allKnown = false;
  }
  return allKnown ? null : undefined;
}

async function windowsIcons(requests: AppIconRequest[]): Promise<(string | undefined)[]> {
  // Only rows with no exe found yet are asked about, so a list that has settled spawns nothing.
  const unknown = requests
    .filter((request) => cachedPath(request) === undefined)
    .flatMap((request) =>
      candidates(request)
        .filter((pid) => !pathByProcess.has(processKey(pid, request.name)))
        .map((pid) => ({ pid, name: request.name })),
    );
  if (unknown.length > 0) {
    const answer = await runPowerShellJson<WindowsIconAnswer>(windowsIconScript(unknown));
    if (answer) {
      const found = new Map(asArray(answer.processes).map((row) => [row.pid, row.path || null]));
      for (const { pid, name } of unknown)
        remember(pathByProcess, processKey(pid, name), found.get(pid) ?? null);
      for (const { path, png } of asArray(answer.icons)) {
        remember(iconByPath, path.toLowerCase(), png ? `data:image/png;base64,${png}` : null);
      }
    }
  }
  return requests.map((request) => {
    const path = cachedPath(request);
    return (path && iconByPath.get(path.toLowerCase())) || undefined;
  });
}

async function exePathForPid(pid: number): Promise<string | undefined> {
  if (!isSafePid(pid)) return undefined;
  try {
    if (process.platform === 'linux') {
      return await readlink(`/proc/${pid}/exe`);
    }
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
      timeout: 2000,
    });
    const comm = stdout.trim();
    return comm.startsWith('/') ? comm : undefined;
  } catch {
    return undefined;
  }
}

async function fileIcon(exePath: string): Promise<string | undefined> {
  const key = exePath.toLowerCase();
  const cached = iconByPath.get(key);
  if (cached) return cached;
  try {
    const url = (await app.getFileIcon(exePath, { size: 'small' })).toDataURL();
    remember(iconByPath, key, url);
    return url;
  } catch {
    return undefined;
  }
}

/** The icon of each app's exe as a PNG data URL, in the order asked. Undefined where none is found. */
export async function iconsForApps(requests: AppIconRequest[]): Promise<(string | undefined)[]> {
  if (process.platform === 'win32') return windowsIcons(requests);
  return Promise.all(
    requests.map(async (request) => {
      const exePath = await exePathForPid(request.pids[0] ?? 0);
      return exePath ? fileIcon(exePath) : undefined;
    }),
  );
}
