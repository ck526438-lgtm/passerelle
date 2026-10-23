import { createSign, createPrivateKey } from 'node:crypto';
import { request } from './http.js';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signJwt({ email, privateKey, scope, tokenUrl, lifetimeSeconds = 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope, aud: tokenUrl, exp: now + lifetimeSeconds, iat: now }));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(privateKey);
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key).toString('base64url');
  return `${signingInput}.${signature}`;
}

/** Service account -> access token, mis en cache jusqu'à expiration. */
export class GoogleTokenSource {
  constructor({ serviceAccount, tokenUrl = 'https://oauth2.googleapis.com/token', scope }) {
    this.claims = typeof serviceAccount === 'string' ? JSON.parse(serviceAccount) : serviceAccount;
    this.tokenUrl = tokenUrl;
    this.scope = scope;
    this.cached = null;
  }

  async token() {
    if (this.cached && this.cached.expiresAt > Date.now() + 30_000) return this.cached.value;
    const assertion = signJwt({
      email: this.claims.client_email,
      privateKey: this.claims.private_key,
      scope: this.scope,
      tokenUrl: this.tokenUrl,
    });
    // Google n'accepte la requête d'échange que formulée en x-www-form-urlencoded.
    const { json } = await request(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!json?.access_token) throw new Error('Google: pas d\'access_token dans la réponse OAuth');
    this.cached = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.cached.value;
  }
}
