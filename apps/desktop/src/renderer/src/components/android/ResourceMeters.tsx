import type { AndroidUsage } from '@runova/core';
import { Cpu, MemoryStick } from '@/components/icons';

/**
 * CPU and memory for one emulator. CPU is a delta between two samples on Windows and Linux, so
 * the first tick genuinely has no rate to report. Showing "measuring" there is honest; showing 0%
 * would read as an idle emulator, which is the one thing a freshly started one never is.
 */

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

interface MeterProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  /** 0 to 100, or null when there is nothing to draw yet. */
  percent: number | null;
}

function Meter({ icon, label, value, percent }: MeterProps): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
        <span className="ml-auto shrink-0 tabular-nums text-foreground">{value}</span>
      </div>
      <div
        className="h-[3px] overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${Math.min(100, Math.max(0, percent ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

export function ResourceMeters({ usage }: { usage: AndroidUsage }): React.JSX.Element {
  return (
    <div className="flex items-start gap-4">
      <Meter
        icon={<Cpu className="h-3 w-3" />}
        label="CPU"
        value={usage.cpuReady ? `${Math.round(usage.cpuPercent)}%` : 'measuring'}
        percent={usage.cpuReady ? usage.cpuPercent : null}
      />
      <Meter
        icon={<MemoryStick className="h-3 w-3" />}
        label="Memory"
        value={formatBytes(usage.memoryBytes)}
        percent={null}
      />
    </div>
  );
}
