// Identity derivation. A "session secret" is a high-entropy bearer the client holds;
// the public userId is its hash. The server authenticates purely by hashing the
// presented secret — it stores no secret, and you can only ever act as your own hash,
// so you cannot impersonate another userId without knowing its secret.

import { createHash, randomBytes } from 'node:crypto';

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function deriveUserId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 12);
}
