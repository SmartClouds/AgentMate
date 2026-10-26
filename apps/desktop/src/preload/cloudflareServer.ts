import { ipcRenderer } from 'electron';
import type {
  CloudflareDnsTokenInput,
  CloudflareOriginCertificateInput,
  CloudflareOriginLockInput,
  CloudflareOriginLockPlan,
  CloudflareRemoveDnsTokenInput,
} from '../shared/cloudflareTypes';
import type {
  CertificateUploadResult,
  DnsCredentialInfo,
  OriginLockResult,
  OriginLockStatus,
} from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { IPC } from '../shared/ipcChannels';

/**
 * Cloudflare work on one server (E14): the origin lock, Origin CA certificates and the DNS
 * tokens a server keeps for DNS-01. The account token never crosses here; a pasted DNS token
 * goes in once and never comes back.
 */
export const cloudflareServer = {
  originLock: (serverId: string): Promise<OriginLockStatus> =>
    ipcRenderer.invoke(IPC.cloudflareServer.originLock, serverId),
  /** The firewall change the lock needs and how the server's domains stand in Cloudflare. */
  previewOriginLock: (input: CloudflareOriginLockInput): Promise<CloudflareOriginLockPlan> =>
    ipcRenderer.invoke(IPC.cloudflareServer.previewOriginLock, input),
  /** Applies it; the firewall change then waits for its confirmation in the Firewall section. */
  applyOriginLock: (input: CloudflareOriginLockInput): Promise<OriginLockResult> =>
    ipcRenderer.invoke(IPC.cloudflareServer.applyOriginLock, input),
  originCertificate: (input: CloudflareOriginCertificateInput): Promise<CertificateUploadResult> =>
    ipcRenderer.invoke(IPC.cloudflareServer.originCertificate, input),
  dnsTokens: (serverId: string): Promise<DnsCredentialInfo[]> =>
    ipcRenderer.invoke(IPC.cloudflareServer.dnsTokens, serverId),
  provisionDnsToken: (input: CloudflareDnsTokenInput): Promise<DnsCredentialInfo> =>
    ipcRenderer.invoke(IPC.cloudflareServer.provisionDnsToken, input),
  removeDnsToken: (input: CloudflareRemoveDnsTokenInput): Promise<void> =>
    ipcRenderer.invoke(IPC.cloudflareServer.removeDnsToken, input),
};
