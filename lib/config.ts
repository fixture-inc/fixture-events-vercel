import { createHash } from 'node:crypto';
import { z } from 'zod';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Configure ${name} on the server.`);
  return value;
}

export function connectConfig() {
  const connector = required('CONNECTOR_ID');
  const mcpUrl = z.url().parse(required('FIXTURE_MCP_URL'));
  if (!mcpUrl.startsWith('https://')) throw new Error('MCP requires HTTPS.');
  const environment = required('VERCEL_TARGET_ENV');
  if (['preview', 'development'].includes(environment)) {
    throw new Error('Use Vercel Production or a stable Custom environment.');
  }
  const projectId = required('VERCEL_PROJECT_ID');
  const ownerId = required('VERCEL_ORG_ID');
  const tokenParams = {
    subject: { type: 'user' as const, id: required('DEMO_SUBJECT_ID') },
    scopes: required('FIXTURE_SCOPES').split(/\s+/).sort(),
  };
  const scope = createHash('sha256')
    .update(
      JSON.stringify({
        connector,
        mcpUrl,
        projectId,
        ownerId,
        environment,
        customEnvironmentId: process.env.CONNECT_CUSTOM_ENVIRONMENT_ID,
        tokenParams,
      }),
    )
    .digest('hex');
  return { connector, mcpUrl, tokenParams, scope, projectId, ownerId, environment };
}

export function receiverConfig() {
  return {
    path: '/hooks',
    projectId: required('VERCEL_PROJECT_ID'),
    ownerId: required('VERCEL_ORG_ID'),
    environment: required('VERCEL_TARGET_ENV'),
    issuer: required('CONNECT_OIDC_ISSUER'),
    audience: required('CONNECT_OIDC_AUDIENCE'),
    customEnvironmentId: process.env.CONNECT_CUSTOM_ENVIRONMENT_ID || undefined,
  };
}
