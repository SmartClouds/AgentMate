import { createHash } from 'node:crypto';
import { win32 } from 'node:path';

/**
 * Windows has no SIGSTOP. `NtSuspendProcess` freezes every thread of a process (what Process
 * Explorer and PsSuspend use), so a small C# class calls it over P/Invoke from PowerShell. The
 * class also walks the tree itself with a Toolhelp snapshot, which is far quicker than a CIM
 * query when the CPU is pegged (the very moment someone reaches for Pause).
 *
 * Written for the C# 5 compiler that ships with Windows PowerShell 5.1: no string
 * interpolation, no `out var`.
 */
export const PROCESS_TREE_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentMateProcessTree {
  const uint TH32CS_SNAPPROCESS = 0x2;
  const uint PROCESS_SUSPEND_RESUME = 0x0800;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int ERROR_ACCESS_DENIED = 5;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtSuspendProcess(IntPtr process);
  [DllImport("ntdll.dll")]
  static extern int NtResumeProcess(IntPtr process);

  class Entry { public uint Pid; public uint Parent; public string Name; }

  static List<Entry> Snapshot() {
    List<Entry> all = new List<Entry>();
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) return all;
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (!Process32FirstW(snapshot, ref entry)) return all;
      do {
        Entry e = new Entry();
        e.Pid = entry.th32ProcessID;
        e.Parent = entry.th32ParentProcessID;
        e.Name = entry.szExeFile;
        all.Add(e);
      } while (Process32NextW(snapshot, ref entry));
    } finally {
      CloseHandle(snapshot);
    }
    return all;
  }

  static long Started(uint pid, Dictionary<uint, long> cache) {
    long known;
    if (cache.TryGetValue(pid, out known)) return known;
    long creation = -1;
    IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (handle != IntPtr.Zero) {
      long exit, kernel, user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) creation = -1;
      CloseHandle(handle);
    }
    cache[pid] = creation;
    return creation;
  }

  // The root and every process below it, parents first. Windows never reparents, so an
  // orphan keeps its dead parent's pid; when a newer process reused that pid, the orphan is
  // older than its "parent" and is left out.
  static List<Entry> Tree(uint root, List<Entry> all) {
    Dictionary<uint, List<Entry>> children = new Dictionary<uint, List<Entry>>();
    Entry rootEntry = null;
    foreach (Entry e in all) {
      if (e.Pid == root) rootEntry = e;
      if (e.Pid == e.Parent) continue;
      List<Entry> list;
      if (!children.TryGetValue(e.Parent, out list)) {
        list = new List<Entry>();
        children[e.Parent] = list;
      }
      list.Add(e);
    }
    List<Entry> order = new List<Entry>();
    if (rootEntry == null) return order;
    Dictionary<uint, long> started = new Dictionary<uint, long>();
    HashSet<uint> seen = new HashSet<uint>();
    Queue<Entry> queue = new Queue<Entry>();
    seen.Add(root);
    order.Add(rootEntry);
    queue.Enqueue(rootEntry);
    while (queue.Count > 0) {
      Entry parent = queue.Dequeue();
      List<Entry> list;
      if (!children.TryGetValue(parent.Pid, out list)) continue;
      foreach (Entry child in list) {
        if (seen.Contains(child.Pid)) continue;
        long parentStarted = Started(parent.Pid, started);
        long childStarted = Started(child.Pid, started);
        if (parentStarted >= 0 && childStarted >= 0 && childStarted < parentStarted) continue;
        seen.Add(child.Pid);
        order.Add(child);
        queue.Enqueue(child);
      }
    }
    return order;
  }

  // Null when it worked, "gone" when the process no longer exists, otherwise why it failed.
  static string Apply(uint pid, bool suspend) {
    IntPtr handle = OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
    if (handle == IntPtr.Zero) {
      return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED ? "access denied" : "gone";
    }
    try {
      int status = suspend ? NtSuspendProcess(handle) : NtResumeProcess(handle);
      return status == 0 ? null : "status 0x" + status.ToString("X8");
    } finally {
      CloseHandle(handle);
    }
  }

  public static string Suspend(int root) {
    List<uint> pids = new List<uint>();
    List<string> names = new List<string>();
    List<string> failed = new List<string>();
    HashSet<uint> handled = new HashSet<uint>();
    // A second look catches a child started while its parent was being frozen.
    for (int round = 0; round < 3; round++) {
      List<Entry> tree = Tree((uint)root, Snapshot());
      if (round == 0 && tree.Count == 0) {
        failed.Add(Failure((uint)root, "not running"));
        break;
      }
      bool found = false;
      foreach (Entry e in tree) {
        if (!handled.Add(e.Pid)) continue;
        found = true;
        string reason = Apply(e.Pid, true);
        if (reason == null) {
          pids.Add(e.Pid);
          names.Add(e.Name);
        } else if (reason != "gone") {
          failed.Add(Failure(e.Pid, reason));
        }
      }
      if (!found) break;
    }
    return Json(pids, names, failed);
  }

  public static string Resume(int[] order) {
    Dictionary<uint, string> nameOf = new Dictionary<uint, string>();
    foreach (Entry e in Snapshot()) nameOf[e.Pid] = e.Name;
    List<uint> pids = new List<uint>();
    List<string> names = new List<string>();
    List<string> failed = new List<string>();
    foreach (int value in order) {
      uint pid = (uint)value;
      string reason = Apply(pid, false);
      if (reason == null) {
        pids.Add(pid);
        string name;
        names.Add(nameOf.TryGetValue(pid, out name) ? name : "");
      } else if (reason != "gone") {
        failed.Add(Failure(pid, reason));
      }
    }
    return Json(pids, names, failed);
  }

  static string Quote(string text) {
    StringBuilder sb = new StringBuilder("\"");
    foreach (char c in text ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }

  static string Failure(uint pid, string reason) {
    return "{\"pid\":" + pid + ",\"reason\":" + Quote(reason) + "}";
  }

  static string Json(List<uint> pids, List<string> names, List<string> failed) {
    List<string> quoted = new List<string>();
    foreach (string name in names) quoted.Add(Quote(name));
    List<string> numbers = new List<string>();
    foreach (uint pid in pids) numbers.Add(pid.ToString());
    return "{\"pids\":[" + string.Join(",", numbers) + "],\"names\":[" + string.Join(",", quoted) +
      "],\"failed\":[" + string.Join(",", failed) + "]}";
  }
}
`;

/** Named after the source, so a changed helper is built afresh instead of loading a stale one. */
export function helperAssemblyPath(helperDir: string): string {
  const hash = createHash('sha256').update(PROCESS_TREE_HELPER_SOURCE).digest('hex').slice(0, 12);
  return win32.join(helperDir, `agentmate-proc-${hash}.dll`);
}

function literal(path: string): string {
  return `'${path.replace(/'/g, "''")}'`;
}

function sourceBlock(): string {
  // A single-quoted here-string takes the C# verbatim; it only ends at a line starting with '@.
  return `$source = @'\n${PROCESS_TREE_HELPER_SOURCE}\n'@`;
}

export function compileScript(assemblyPath: string, helperDir: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `[IO.Directory]::CreateDirectory(${literal(helperDir)}) | Out-Null`,
    sourceBlock(),
    `Add-Type -TypeDefinition $source -OutputAssembly ${literal(assemblyPath)} -OutputType Library`,
  ].join('\n');
}

/** Runs one helper call, from the built assembly when there is one, else compiled in memory. */
export function callScript(call: string, assemblyPath: string | null): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...(assemblyPath
      ? [`Add-Type -Path ${literal(assemblyPath)}`]
      : [sourceBlock(), 'Add-Type -TypeDefinition $source']),
    `[AgentMateProcessTree]::${call}`,
  ].join('\n');
}
