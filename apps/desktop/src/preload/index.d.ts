import type { RunovaApi } from './index';

declare global {
  interface Window {
    runova: RunovaApi;
  }
}
