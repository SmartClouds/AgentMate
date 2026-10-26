import type {
  ApiTreeNode,
  PostmanCollection,
  PostmanEvent,
  PostmanRequest,
  PostmanRequestItem,
} from '@runova/core';

/**
 * What the API Client page and the main process exchange. Types only, so this file adds nothing
 * to either bundle.
 */

export interface ApiHeader {
  key: string;
  value: string;
}

/** Milliseconds spent in each phase of one request. Phases a reused socket skipped are 0. */
export interface ApiTimings {
  dns: number;
  tcp: number;
  tls: number;
  /** From the socket being ready to the first byte of the response. */
  firstByte: number;
  download: number;
  total: number;
}

export interface ApiResponseData {
  status: number;
  statusText: string;
  headers: ApiHeader[];
  /** Text bodies are sent as they are; anything else is base64. */
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  /** True when the body was larger than the inline limit and only its start is here. */
  bodyTruncated: boolean;
  /** The media type from Content-Type, lower case and without parameters, or ''. */
  mime: string;
  size: { body: number; headers: number };
  timings: ApiTimings;
  httpVersion: string;
}

/** The request as it actually went out, after variables, auth and scripts were applied. */
export interface ApiSentRequest {
  method: string;
  url: string;
  headers: ApiHeader[];
  body: string | null;
}

export interface ApiTestResult {
  name: string;
  passed: boolean;
  skipped: boolean;
  error: string | null;
}

export interface ApiConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | string;
  messages: string[];
  at: number;
}

export interface ApiExecutionResult {
  requestId: string;
  /** True when the server answered, whatever the status code. */
  ok: boolean;
  cancelled: boolean;
  /** Why no response came back: a refused connection, a timeout, a bad URL. */
  error: string | null;
  response: ApiResponseData | null;
  sent: ApiSentRequest | null;
  tests: ApiTestResult[];
  console: ApiConsoleEntry[];
  /** Errors thrown by pre-request or test scripts. */
  scriptErrors: string[];
  startedAt: number;
}

export interface ExecuteApiRequestInput {
  /** Chosen by the renderer so it can cancel the request while it runs. */
  requestId: string;
  request: PostmanRequest;
  events?: PostmanEvent[];
  name?: string;
  /** When the tab belongs to a saved request, its collection and item. Variables and inherited
   *  auth and scripts come from there. */
  collectionId?: string | null;
  itemId?: string | null;
}

export interface ApiCollectionSummary {
  id: string;
  name: string;
  requestCount: number;
  tree: ApiTreeNode[];
  projectIds: string[];
  updatedAt: number;
  /** Why the collection's file could not be read, or null when it is fine. */
  error: string | null;
}

export interface SaveApiRequestInput {
  collectionId: string;
  /** Folder to put a new request in, or null for the top level. Ignored for an existing item. */
  parentId: string | null;
  item: PostmanRequestItem;
}

export interface ApiCollectionDocument {
  id: string;
  collection: PostmanCollection;
}
