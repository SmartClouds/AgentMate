import type { PingIpVersion, PingMethod } from '@runova/core';
import { create } from 'zustand';
import {
  DEFAULT_PING_TARGETS_IPV4,
  DEFAULT_PING_TARGETS_IPV6,
  DEFAULT_PING_URL,
  DEFAULT_PING_URL_INTERVAL_SECONDS,
  MAX_PING_URL_INTERVAL_SECONDS,
  MIN_PING_URL_INTERVAL_SECONDS,
} from '@shared/pingDefaults';

export {
  DEFAULT_PING_TARGETS_IPV4,
  DEFAULT_PING_TARGETS_IPV6,
  DEFAULT_PING_URL,
  DEFAULT_PING_URL_INTERVAL_SECONDS,
  MAX_PING_URL_INTERVAL_SECONDS,
  MIN_PING_URL_INTERVAL_SECONDS,
};

interface PingTargetsState {
  pingTargets: string[];
  pingIpVersion: PingIpVersion;
  pingTargetsIpv6: string[];
  pingMethod: PingMethod;
  pingUrls: string[];
  pingUrlIntervalSeconds: number;
  setPingTargets: (targets: string[]) => void;
  setPingIpVersion: (version: PingIpVersion) => void;
  setPingTargetsIpv6: (targets: string[]) => void;
  setPingMethod: (method: PingMethod) => void;
  setPingUrls: (urls: string[]) => void;
  setPingUrlIntervalSeconds: (seconds: number) => void;
}

export const usePingTargetsStore = create<PingTargetsState>((set) => ({
  pingTargets: [...DEFAULT_PING_TARGETS_IPV4],
  pingIpVersion: 'ipv4',
  pingTargetsIpv6: [...DEFAULT_PING_TARGETS_IPV6],
  pingMethod: 'icmp',
  pingUrls: [DEFAULT_PING_URL],
  pingUrlIntervalSeconds: DEFAULT_PING_URL_INTERVAL_SECONDS,
  setPingTargets: (targets) => {
    set({ pingTargets: targets });
    void window.runova.settings.update({ pingTargets: targets });
  },
  setPingIpVersion: (version) => {
    set({ pingIpVersion: version });
    void window.runova.settings.update({ pingIpVersion: version });
  },
  setPingTargetsIpv6: (targets) => {
    set({ pingTargetsIpv6: targets });
    void window.runova.settings.update({ pingTargetsIpv6: targets });
  },
  setPingMethod: (method) => {
    set({ pingMethod: method });
    void window.runova.settings.update({ pingMethod: method });
  },
  setPingUrls: (urls) => {
    set({ pingUrls: urls });
    void window.runova.settings.update({ pingUrls: urls });
  },
  setPingUrlIntervalSeconds: (seconds) => {
    set({ pingUrlIntervalSeconds: seconds });
    void window.runova.settings.update({ pingUrlIntervalSeconds: seconds });
  },
}));

export async function initPingTargets(): Promise<void> {
  const settings = await window.runova.settings.get();
  usePingTargetsStore.setState({
    pingTargets: settings.pingTargets ?? [...DEFAULT_PING_TARGETS_IPV4],
    pingIpVersion: settings.pingIpVersion ?? 'ipv4',
    pingTargetsIpv6: settings.pingTargetsIpv6 ?? [...DEFAULT_PING_TARGETS_IPV6],
    pingMethod: settings.pingMethod ?? 'icmp',
    pingUrls: settings.pingUrls ?? [DEFAULT_PING_URL],
    pingUrlIntervalSeconds: settings.pingUrlIntervalSeconds ?? DEFAULT_PING_URL_INTERVAL_SECONDS,
  });
}
