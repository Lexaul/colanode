import {
  OutgoingHttpHeader,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

import { EXPOSED_HEADERS } from '@tus/server';
import { FastifyReply } from 'fastify';

const REPLY_CORS_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'vary',
]);

// Headers @tus/server may set itself. 2.3 adds them only after header
// validation, so a 400/412 never gets them, and with no allowedOrigins it
// reflects any Origin (or falls back to "*"). 2.4 defaults that header to
// "*". Strip them so the values copied from @fastify/cors stay put.
const TUS_CORS_HEADERS = new Set([
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-max-age',
]);

type WriteHeadHeaders = OutgoingHttpHeaders | OutgoingHttpHeader[];

const stripTusCorsHeaders = (
  headers: WriteHeadHeaders | undefined
): WriteHeadHeaders | undefined => {
  if (headers === undefined) {
    return undefined;
  }

  if (Array.isArray(headers)) {
    const next: OutgoingHttpHeader[] = [];
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index];
      const value = headers[index + 1];
      if (typeof name !== 'string' || value === undefined) {
        continue;
      }
      if (TUS_CORS_HEADERS.has(name.toLowerCase())) {
        continue;
      }
      next.push(name, value);
    }
    return next;
  }

  const next: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || TUS_CORS_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    next[name] = value;
  }
  return next;
};

const keepFastifyCorsOnWriteHead = (raw: ServerResponse): void => {
  const originalWriteHead = raw.writeHead.bind(raw);

  raw.writeHead = ((
    statusCode: number,
    reasonOrHeaders?: string | WriteHeadHeaders,
    headers?: WriteHeadHeaders
  ) => {
    if (typeof reasonOrHeaders === 'string') {
      return originalWriteHead(
        statusCode,
        reasonOrHeaders,
        stripTusCorsHeaders(headers)
      );
    }

    return originalWriteHead(statusCode, stripTusCorsHeaders(reasonOrHeaders));
  }) as ServerResponse['writeHead'];
};

// Tus writes the Node response directly, so Fastify never flushes the CORS
// headers its onRequest hook stored on the reply. Copy those headers onto the
// raw response and stop tus from replacing them.
export const applyTusResponseCors = (reply: FastifyReply): void => {
  const headers = reply.getHeaders();
  let corsEnabled = false;

  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      (typeof value !== 'string' &&
        typeof value !== 'number' &&
        !Array.isArray(value))
    ) {
      continue;
    }

    const lowerName = name.toLowerCase();
    if (!REPLY_CORS_HEADERS.has(lowerName)) {
      continue;
    }

    if (
      lowerName === 'access-control-allow-origin' ||
      lowerName === 'access-control-allow-credentials'
    ) {
      corsEnabled = true;
    }

    reply.raw.setHeader(name, value);
  }

  if (corsEnabled) {
    reply.raw.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  }

  keepFastifyCorsOnWriteHead(reply.raw);
};
