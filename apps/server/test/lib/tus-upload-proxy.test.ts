import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileStore } from '@tus/file-store';
import { EXPOSED_HEADERS, Server } from '@tus/server';
import { fastify } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { corsPlugin } from '@colanode/server/api/client/plugins/cors';
import { serverConfigSchema } from '@colanode/server/lib/config/server';
import {
  generateUrl,
  joinPublicUrl,
  normalizeForwardedProto,
} from '@colanode/server/lib/fastify';
import { applyTusResponseCors } from '@colanode/server/lib/tus-cors';

const app = fastify({
  trustProxy: true,
});

let directory = '';

app.register(corsPlugin);
app.post<{ Params: { fileId: string } }>(
  '/files/:fileId/tus',
  async (request, reply) => {
    normalizeForwardedProto(request);
    const url = generateUrl(request, `/files/${request.params.fileId}/tus`);
    const tusServer = new Server({
      path: '/tus',
      datastore: new FileStore({ directory }),
      generateUrl() {
        return url;
      },
    });

    applyTusResponseCors(reply);
    await tusServer.handle(request.raw, reply.raw);
  }
);

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'colanode-tus-'));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

const exposedHeader = (headers: Record<string, unknown>) => {
  const value = headers['access-control-expose-headers'];
  return Array.isArray(value) ? value.join(', ') : String(value ?? '');
};

describe('forwarded proto normalization', () => {
  it.each([
    ['https, https', 'https'],
    ['http, https', 'https'],
    ['https, http', 'http'],
    [' HTTPS ', 'https'],
    ['HTTPS, HTTPS', 'https'],
    ['HTTP, https', 'https'],
  ])(
    'collapses %j to %s for the upload URL',
    async (forwardedProto, protocol) => {
      const response = await app.inject({
        method: 'POST',
        url: '/files/file-1/tus',
        headers: {
          host: 'noteserver.cystar.work',
          origin: 'http://localhost:4000',
          'tus-resumable': '1.0.0',
          'upload-length': '4',
          'x-forwarded-proto': forwardedProto,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.headers.location).toBe(
        `${protocol}://noteserver.cystar.work/files/file-1/tus`
      );
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:4000'
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      const exposed = exposedHeader(response.headers);
      expect(exposed).toBe(EXPOSED_HEADERS);
      expect(exposed).toContain('Location');
      expect(exposed).toContain('Upload-Offset');
      expect(exposed).toContain('Upload-Length');
      expect(exposed).toContain('Tus-Resumable');
      expect(exposed).toContain('Upload-Metadata');
    }
  );

  it('drops an unusable forwarded proto instead of rejecting the upload', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/files/file-2/tus',
      headers: {
        host: 'noteserver.cystar.work',
        origin: 'https://evil.example',
        'tus-resumable': '1.0.0',
        'upload-length': '4',
        'x-forwarded-proto': 'nope',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(String(response.headers.location)).toMatch(
      /^http:\/\/noteserver\.cystar\.work\//
    );
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4000'
    );
    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers['access-control-allow-origin']).not.toBe(
      'https://evil.example'
    );
  });

  it('joins an array proto header the same way Node joins duplicates', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/files/file-3/tus',
      headers: {
        host: 'noteserver.cystar.work',
        'tus-resumable': '1.0.0',
        'upload-length': '4',
        'x-forwarded-proto': ['HTTP', 'https'],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBe(
      'https://noteserver.cystar.work/files/file-3/tus'
    );
  });
});

describe('tus CORS override', () => {
  const bare = fastify();

  bare.post('/raw', async (_request, reply) => {
    applyTusResponseCors(reply);
    reply.raw.writeHead(400, 'Bad Request', [
      'content-type',
      'text/plain',
      'access-control-allow-origin',
      '*',
      'access-control-allow-credentials',
      'true',
      'x-tus',
      'yes',
    ]);
    reply.raw.end('Invalid x-forwarded-proto\n');
  });

  beforeAll(async () => {
    await bare.ready();
  });

  afterAll(async () => {
    await bare.close();
  });

  it('does not let tus replace a missing CORS policy with a wildcard', async () => {
    const response = await bare.inject({
      method: 'POST',
      url: '/raw',
      headers: {
        origin: 'https://evil.example',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Invalid x-forwarded-proto');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      response.headers['access-control-allow-credentials']
    ).toBeUndefined();
    expect(response.headers['access-control-expose-headers']).toBeUndefined();
    expect(response.headers['x-tus']).toBe('yes');
  });
});

describe('tus error CORS', () => {
  it('keeps API CORS headers on tus validation errors', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/files/file-4/tus',
      headers: {
        host: 'noteserver.cystar.work',
        origin: 'http://localhost:4000',
        'tus-resumable': '1.0.0',
        'upload-length': 'nope',
        'x-forwarded-proto': 'https, https',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Invalid upload-length');
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4000'
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(exposedHeader(response.headers)).toContain('Location');
  });

  it('keeps API CORS headers when tus-resumable is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/files/file-5/tus',
      headers: {
        origin: 'http://localhost:4000',
        'upload-length': '4',
        'x-forwarded-proto': 'https, https',
      },
    });

    expect(response.statusCode).toBe(412);
    expect(response.body).toContain('Tus-Resumable Required');
    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4000'
    );
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });
});

describe('public server URL', () => {
  it('joins a configured origin with the path prefix', () => {
    expect(
      joinPublicUrl(
        'https://noteserver.example.com',
        'colanode',
        '/client/v1/workspaces/w/files/f/tus'
      )
    ).toBe(
      'https://noteserver.example.com/colanode/client/v1/workspaces/w/files/f/tus'
    );
    expect(
      joinPublicUrl(
        'https://noteserver.example.com',
        undefined,
        '/client/v1/config'
      )
    ).toBe('https://noteserver.example.com/client/v1/config');
  });

  it('normalizes server.url to an http(s) origin', () => {
    expect(
      serverConfigSchema.parse({
        url: 'https://noteserver.example.com/ignored?x=1',
      }).url
    ).toBe('https://noteserver.example.com');
    expect(
      serverConfigSchema.parse({ url: 'https://noteserver.example.com:8443/' })
        .url
    ).toBe('https://noteserver.example.com:8443');
    expect(serverConfigSchema.parse({}).url).toBeUndefined();
    expect(() =>
      serverConfigSchema.parse({ url: 'ftp://example.com' })
    ).toThrow();
    expect(() =>
      serverConfigSchema.parse({ url: 'noteserver.example.com' })
    ).toThrow();
  });

  it('resolves env:// references on server.url', () => {
    const previous = process.env.PUBLIC_SERVER_URL;
    process.env.PUBLIC_SERVER_URL = 'https://noteserver.cystar.work/api';

    try {
      expect(
        serverConfigSchema.parse({ url: 'env://PUBLIC_SERVER_URL' }).url
      ).toBe('https://noteserver.cystar.work');
    } finally {
      if (previous === undefined) {
        delete process.env.PUBLIC_SERVER_URL;
      } else {
        process.env.PUBLIC_SERVER_URL = previous;
      }
    }
  });
});
