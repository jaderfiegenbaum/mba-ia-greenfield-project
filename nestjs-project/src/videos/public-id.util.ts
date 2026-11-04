import { randomBytes } from 'node:crypto';

export const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

// 64 random bits → 11 base64url chars (phase-03-videos/TD-05). Uniqueness is
// enforced by the unique index on videos.public_id; callers retry on conflict.
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
