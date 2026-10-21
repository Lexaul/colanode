import { z } from 'zod/v4';

import { resolveOptionalConfigReference } from './utils';

const normalizeServerUrl = (
  value: string | undefined,
  ctx: z.core.$RefinementCtx<string | undefined>
): string | undefined => {
  const resolved = resolveOptionalConfigReference(value, ctx);
  if (resolved === undefined) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    ctx.addIssue({
      code: 'invalid_value',
      message: 'Server URL must be an absolute http(s) URL',
      values: [resolved],
    });
    return z.NEVER;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    ctx.addIssue({
      code: 'invalid_value',
      message: 'Server URL must use http or https',
      values: [resolved],
    });
    return z.NEVER;
  }

  return url.origin;
};

export const serverConfigSchema = z
  .object({
    url: z.string().optional().transform(normalizeServerUrl),
  })
  .prefault({});

export type ServerConfig = z.infer<typeof serverConfigSchema>;
