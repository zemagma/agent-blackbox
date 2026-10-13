// A small client for the Claus Network API, covering only the operations this
// project uses. Routes follow the public OpenAPI description
// (https://claus-network-api.vercel.app/openapi.json).

export const DEFAULT_ORIGIN = 'https://claus-network-api.vercel.app';

const ROUTES = {
  capabilities: ['GET', '/v1/public/capabilities', true],
  auth_challenge: ['POST', '/v1/auth/challenge', true],
  auth_session: ['POST', '/v1/auth/session', true],
  project_create: ['POST', '/v1/projects'],
  project_get: ['GET', '/v1/projects/{projectId}'],
  project_publish: ['PUT', '/v1/projects/{projectId}/publication'],
  agent_create: ['POST', '/v1/projects/{projectId}/agents'],
  mandate_create: ['POST', '/v1/projects/{projectId}/mandates'],
  mandate_revoke: ['DELETE', '/v1/mandates/{mandateId}'],
  credential_create: ['POST', '/v1/credentials'],
  service_register: ['POST', '/v1/projects/{projectId}/services'],
  service_get: ['GET', '/v1/projects/{projectId}/services/{serviceId}'],
  service_publish: ['PUT', '/v1/projects/{projectId}/services/{serviceId}/publication'],
  service_quote: ['POST', '/v1/projects/{projectId}/service-quotes'],
  service_accept: ['POST', '/v1/projects/{projectId}/service-orders'],
  service_order: ['GET', '/v1/projects/{projectId}/service-orders/{orderId}'],
  service_result: ['GET', '/v1/projects/{projectId}/service-orders/{orderId}/result'],
  service_accept_result: ['POST', '/v1/projects/{projectId}/service-orders/{orderId}/acceptance'],
  service_result_publication: ['GET', '/v1/projects/{projectId}/service-orders/{orderId}/publication'],
  service_result_publish: ['PUT', '/v1/projects/{projectId}/service-orders/{orderId}/publication'],
  public_service_result: ['GET', '/v1/public/service-results/{orderId}', true],
  provider_orders: ['GET', '/v1/projects/{projectId}/service-assignments'],
  provider_claim: ['POST', '/v1/projects/{projectId}/service-assignments/{orderId}/claim'],
  provider_deliver: ['PUT', '/v1/projects/{projectId}/service-assignments/{orderId}/delivery'],
};

export class ClausError extends Error {
  constructor(code, status, details) { super(code); this.name = 'ClausError'; this.code = code; this.status = status; this.details = details; }
}

export function createClaus({ origin = DEFAULT_ORIGIN, token, fetch: request = globalThis.fetch } = {}) {
  const base = new URL(origin);
  const local = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol !== 'https:' && !local) throw new Error('Claus: HTTPS required');
  return {
    origin: base.origin,
    async call(name, input = {}) {
      const route = ROUTES[name];
      if (!route) throw new Error('Claus: unknown operation ' + name);
      const [method, template, isPublic] = route;
      const rest = { ...input };
      const path = template.replace(/\{(\w+)\}/g, (_, key) => {
        const value = rest[key];
        if (typeof value !== 'string' || !value) throw new Error('Claus: missing ' + key);
        delete rest[key];
        return encodeURIComponent(value);
      });
      const url = new URL(path, base);
      const headers = { accept: 'application/json' };
      if (!isPublic && token) headers.authorization = 'Bearer ' + token;
      let body;
      if (method === 'GET') {
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) url.searchParams.set(k, String(v));
      } else if (Object.keys(rest).length) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(rest);
      }
      // Mutations are never retried automatically, and credentials never follow redirects.
      const res = await request(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(30000) });
      let json;
      try { json = await res.json(); } catch { throw new ClausError('invalid_api_response', res.status); }
      if (!res.ok) throw new ClausError(json.error ?? 'request_failed', res.status, json);
      return json;
    },
  };
}

/**
 * Signs in an EOA as a Claus owner. `account` is a viem local account.
 * The challenge text is checked before signing so a hostile server cannot get
 * a signature for a different domain or chain.
 */
export async function ownerLogin(origin, account) {
  const guest = createClaus({ origin });
  const challenge = await guest.call('auth_challenge', { address: account.address });
  const msg = String(challenge.message ?? '');
  const lines = msg.split('\n');
  if (!lines[1] || lines[1].toLowerCase() !== account.address.toLowerCase()) throw new Error('Claus: challenge names a different address');
  if (!/\nChain ID: 1\n/.test(msg)) throw new Error('Claus: challenge is not for chain 1');
  if (!msg.endsWith('Request ID: ' + challenge.id)) throw new Error('Claus: challenge id mismatch');
  if (!(challenge.expiresAt > Date.now())) throw new Error('Claus: challenge already expired');
  const session = await guest.call('auth_session', { challengeId: challenge.id, signature: await account.signMessage({ message: msg }) });
  return { session, client: createClaus({ origin, token: session.token }) };
}

export const publicResultUrl = (origin, orderId) => new URL('/v1/public/service-results/' + encodeURIComponent(orderId), origin).href;
