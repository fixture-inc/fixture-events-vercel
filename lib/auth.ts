import { createHash, timingSafeEqual } from 'node:crypto';
import { required } from './config';

export function authorized(request: Request): boolean {
  const password = required('DEMO_PASSWORD');
  if (password.length < 32) throw new Error('DEMO_PASSWORD must contain at least 32 characters.');
  const expected = `Basic ${Buffer.from(`${required('DEMO_USER')}:${password}`).toString('base64')}`;
  const hash = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(hash(request.headers.get('authorization') ?? ''), hash(expected));
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === new URL(required('APP_ORIGIN')).origin;
}
