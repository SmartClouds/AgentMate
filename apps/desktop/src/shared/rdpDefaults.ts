import type { RdpServerOptions } from './apiTypes';

export const DEFAULT_RDP_PORT = 3389;

export const DEFAULT_RDP_OPTIONS: RdpServerOptions = {
  resolution: 'fitWindow',
  fullscreenOnConnect: false,
  maximizeOnConnect: false,
  clipboard: true,
  fileTransfer: true,
  nla: true,
};

/** Fills in options a record saved by an older version doesn't have yet. */
export function withRdpDefaults(options: Partial<RdpServerOptions> | undefined): RdpServerOptions {
  return { ...DEFAULT_RDP_OPTIONS, ...options };
}
