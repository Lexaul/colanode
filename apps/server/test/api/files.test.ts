import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiErrorCode, FileStatus } from '@colanode/core';
import { database } from '@colanode/server/data/database';
import { updateNode } from '@colanode/server/lib/nodes';
import { buildTestApp } from '../helpers/app';
import {
  buildAuthHeader,
  createAccount,
  createDevice,
  createFileNode,
  createSpaceNode,
  createUser,
  createWorkspace,
} from '../helpers/seed';

const app = buildTestApp();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const extractPath = (location?: string) => {
  if (!location) {
    throw new Error('Missing Location header');
  }

  try {
    const url = new URL(location);
    return url.pathname;
  } catch {
    return location;
  }
};

describe('file uploads', () => {
  it('marks file Ready and sets uploaded_at after TUS completion', async () => {
    const account = await createAccount({
      email: 'upload@example.com',
    });

    const workspace = await createWorkspace({
      createdBy: account.id,
    });

    const user = await createUser({
      workspaceId: workspace.id,
      account,
      role: 'owner',
    });

    const { token } = await createDevice({ accountId: account.id });

    const rootId = await createSpaceNode({
      workspaceId: workspace.id,
      userId: user.id,
    });

    const payload = Buffer.from('hello world');
    const fileId = await createFileNode({
      workspaceId: workspace.id,
      userId: user.id,
      parentId: rootId,
      rootId,
      size: payload.length,
      name: 'upload.txt',
      extension: '.txt',
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: `/client/v1/workspaces/${workspace.id}/files/${fileId}/tus`,
      headers: {
        ...buildAuthHeader(token),
        'Tus-Resumable': '1.0.0',
        'Upload-Length': payload.length.toString(),
      },
    });

    expect([201, 204]).toContain(createResponse.statusCode);

    const location = createResponse.headers.location as string | undefined;
    const uploadPath = extractPath(location);

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: uploadPath,
      headers: {
        ...buildAuthHeader(token),
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
        'Content-Length': payload.length.toString(),
      },
      payload,
    });

    expect([200, 204]).toContain(patchResponse.statusCode);

    const upload = await database
      .selectFrom('uploads')
      .selectAll()
      .where('file_id', '=', fileId)
      .executeTakeFirst();

    expect(upload?.uploaded_at).not.toBeNull();

    const node = await database
      .selectFrom('nodes')
      .selectAll()
      .where('id', '=', fileId)
      .executeTakeFirst();

    expect(node).not.toBeNull();
    const attributes = node?.attributes as { status?: number } | null;
    expect(attributes?.status).toBe(FileStatus.Ready);
  });

  it('accepts a proxy chain proto and returns API CORS headers', async () => {
    const account = await createAccount({
      email: 'upload-proxy@example.com',
    });

    const workspace = await createWorkspace({
      createdBy: account.id,
    });

    const user = await createUser({
      workspaceId: workspace.id,
      account,
      role: 'owner',
    });

    const { token } = await createDevice({ accountId: account.id });

    const rootId = await createSpaceNode({
      workspaceId: workspace.id,
      userId: user.id,
    });

    const fileId = await createFileNode({
      workspaceId: workspace.id,
      userId: user.id,
      parentId: rootId,
      rootId,
      size: 11,
      name: 'proxy.txt',
      extension: '.txt',
    });

    const uploadUrl = `/client/v1/workspaces/${workspace.id}/files/${fileId}/tus`;
    const headers = {
      ...buildAuthHeader(token),
      host: 'noteserver.cystar.work',
      origin: 'http://localhost:4000',
      'x-forwarded-proto': 'https, https',
    };

    const invalidLength = await app.inject({
      method: 'POST',
      url: uploadUrl,
      headers: {
        ...headers,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': 'nope',
      },
    });

    expect(invalidLength.statusCode).toBe(400);
    expect(invalidLength.body).toContain('Invalid upload-length');
    expect(invalidLength.headers['access-control-allow-origin']).toBe(
      'http://localhost:4000'
    );
    expect(invalidLength.headers['access-control-allow-credentials']).toBe(
      'true'
    );
    expect(
      String(invalidLength.headers['access-control-expose-headers'])
    ).toContain('Location');

    const createResponse = await app.inject({
      method: 'POST',
      url: uploadUrl,
      headers: {
        ...headers,
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '11',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.headers.location).toBe(
      `https://noteserver.cystar.work${uploadUrl}`
    );
    expect(createResponse.headers['access-control-allow-origin']).toBe(
      'http://localhost:4000'
    );
    expect(createResponse.headers['access-control-allow-credentials']).toBe(
      'true'
    );
    expect(createResponse.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('file download guards', () => {
  it('rejects download when file is not ready or upload missing', async () => {
    const account = await createAccount({
      email: 'download@example.com',
    });

    const workspace = await createWorkspace({
      createdBy: account.id,
    });

    const user = await createUser({
      workspaceId: workspace.id,
      account,
      role: 'owner',
    });

    const { token } = await createDevice({ accountId: account.id });

    const rootId = await createSpaceNode({
      workspaceId: workspace.id,
      userId: user.id,
    });

    const fileId = await createFileNode({
      workspaceId: workspace.id,
      userId: user.id,
      parentId: rootId,
      rootId,
      size: 10,
    });

    const notReadyResponse = await app.inject({
      method: 'GET',
      url: `/client/v1/workspaces/${workspace.id}/files/${fileId}`,
      headers: buildAuthHeader(token),
    });

    expect(notReadyResponse.statusCode).toBe(400);
    expect(notReadyResponse.json()).toMatchObject({
      code: ApiErrorCode.FileNotReady,
    });

    const updated = await updateNode({
      nodeId: fileId,
      userId: user.id,
      workspaceId: workspace.id,
      updater(attributes) {
        if (attributes.type !== 'file') {
          throw new Error('Node is not a file');
        }
        attributes.status = FileStatus.Ready;
        return attributes;
      },
    });

    expect(updated).toBe(true);

    const missingUploadResponse = await app.inject({
      method: 'GET',
      url: `/client/v1/workspaces/${workspace.id}/files/${fileId}`,
      headers: buildAuthHeader(token),
    });

    expect(missingUploadResponse.statusCode).toBe(400);
    expect(missingUploadResponse.json()).toMatchObject({
      code: ApiErrorCode.FileUploadNotFound,
    });
  });
});
