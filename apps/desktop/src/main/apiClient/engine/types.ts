import type { PostmanCollection } from '@runova/core';
import type {
  ApiResponseData,
  ApiSentRequest,
  ApiTestResult,
} from '../../../shared/apiClientTypes';

/**
 * The contract between main and whatever runs requests. Everything here is plain data, because
 * it crosses into the utility process that hosts Postman's runtime.
 */

export interface EngineVariable {
  key: string;
  value: string;
  type?: string;
  enabled?: boolean;
}

export interface EngineProxy {
  /** http(s)://[user:pass@]host:port */
  url: string;
  /** Hosts that go direct, e.g. "localhost", "*.corp.test". */
  bypass: string[];
}

export interface EngineRunOptions {
  timeoutMs: number;
  strictSSL: boolean;
  followRedirects: boolean;
  maxRedirects?: number;
  /** Bodies larger than this come back cut to this size, with `bodyTruncated` set. */
  maxInlineBodyBytes: number;
  /** Off for collections nobody has chosen to trust yet: their scripts are not run. */
  scriptsEnabled: boolean;
  proxy: EngineProxy | null;
}

export interface EngineRunInput {
  collection: PostmanCollection;
  /** The id of the item or folder to run. Missing runs the whole collection. */
  entrypoint?: string;
  environment?: EngineVariable[];
  globals?: EngineVariable[];
  options: EngineRunOptions;
}

export type EngineEvent =
  | { type: 'request'; itemId: string; sent: ApiSentRequest }
  | {
      type: 'response';
      itemId: string;
      response: ApiResponseData | null;
      sent: ApiSentRequest | null;
      error: string | null;
    }
  | { type: 'assertion'; itemId: string; results: ApiTestResult[] }
  | { type: 'console'; itemId: string | null; level: string; messages: string[] }
  | { type: 'exception'; itemId: string | null; message: string };

export interface EngineRunSummary {
  error: string | null;
  cancelled: boolean;
  environment: EngineVariable[];
  globals: EngineVariable[];
  collectionVariables: EngineVariable[];
}

export interface EngineRun {
  cancel(): void;
  done: Promise<EngineRunSummary>;
}

/** Anything that can run a collection: the utility process in the app, a fake in tests. */
export interface ApiEngine {
  run(input: EngineRunInput, onEvent: (event: EngineEvent) => void): EngineRun;
}
