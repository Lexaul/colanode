import { FastifyRequest } from 'fastify';

import { config } from './config';

const FORWARDED_PROTO = 'x-forwarded-proto';

const protocolFromRequest = (request: FastifyRequest): string => {
  const normalized = request.protocol?.toLowerCase();
  if (normalized === 'http' || normalized === 'https') {
    return normalized;
  }

  return request.protocol ?? 'http';
};

const originFromRequest = (request: FastifyRequest): string => {
  const port =
    request.port && request.port != 80 && request.port != 443
      ? `:${request.port}`
      : '';

  return `${protocolFromRequest(request)}://${request.hostname}${port}`;
};

export const joinPublicUrl = (
  origin: string,
  pathPrefix: string | undefined,
  path: string
): string => {
  const prefix = pathPrefix ? `/${pathPrefix}` : '';
  return `${origin}${prefix}${path}`;
};

export const generateUrl = (request: FastifyRequest, path: string) => {
  const origin = config.server.url ?? originFromRequest(request);
  return joinPublicUrl(origin, config.pathPrefix, path);
};

// @tus/server rejects any X-Forwarded-Proto other than the exact strings
// "http" and "https". A proxy chain joins repeated headers into one value
// ("https, https", "HTTP, https"). Fastify's trustProxy already resolves that
// list to a single protocol (the last hop, trimmed). Rewrite the header to
// that protocol so tus and generateUrl agree, or drop it when it is not a
// usable scheme.
//
// X-Forwarded-Host and X-Forwarded-For are not checked by tus. Fastify already
// reduces a host list to its last entry and parses forwarded addresses, so
// those headers do not need the same rewrite.
export const normalizeForwardedProto = (request: FastifyRequest): void => {
  const headers = request.raw.headers;
  const current = headers[FORWARDED_PROTO];
  if (current === undefined) {
    return;
  }

  if (Array.isArray(current)) {
    headers[FORWARDED_PROTO] = current.join(',');
  }

  const protocol = request.protocol?.toLowerCase();
  if (protocol === 'http' || protocol === 'https') {
    headers[FORWARDED_PROTO] = protocol;
    return;
  }

  delete headers[FORWARDED_PROTO];
};
