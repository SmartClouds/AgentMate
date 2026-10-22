import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Telegram's Bot API on loopback for the Telegram alerts e2e (E30), in the test process. The
 * DevHost core is pointed here (a Development-only setting) and posts its `sendMessage` calls, which
 * this keeps so the spec can check the chat, the text and the token in the address. It answers the
 * way api.telegram.org does: `{"ok":true}`, or an error with a description when the spec asks for
 * one with `refuse`.
 */

export interface TelegramMessage {
  /** The address as called, with the token in it: `/bot<token>/sendMessage`. */
  path: string;
  chatId: string;
  text: string;
}

export interface FakeTelegramApi {
  port: number;
  messages: TelegramMessage[];
  /** Answers the next calls with this HTTP status and description; null goes back to "ok". */
  refuse: (answer: { status: number; description: string } | null) => void;
  stop: () => Promise<void>;
}

export async function startFakeTelegramApi(): Promise<FakeTelegramApi> {
  const messages: TelegramMessage[] = [];
  let refusal: { status: number; description: string } | null = null;
  let nextId = 1;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: { chat_id?: unknown; text?: unknown } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Not JSON: kept with empty fields, so the spec sees the call was wrong.
      }
      messages.push({
        path: request.url ?? '',
        chatId: String(body.chat_id ?? ''),
        text: String(body.text ?? ''),
      });
      response.setHeader('content-type', 'application/json');
      if (refusal) {
        response.writeHead(refusal.status);
        response.end(
          JSON.stringify({
            ok: false,
            error_code: refusal.status,
            description: refusal.description,
          }),
        );
        return;
      }
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    refuse: (answer) => {
      refusal = answer;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
