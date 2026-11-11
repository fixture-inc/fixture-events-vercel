import postgres from 'postgres';
import { required } from './config';

// Connections can be reused, but no correctness-critical state lives in memory.
const globalDb = globalThis as typeof globalThis & { demoSql?: ReturnType<typeof postgres> };
export function db() {
  return (globalDb.demoSql ??= postgres(required('DATABASE_URL'), {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 5,
  }));
}
export type Database = ReturnType<typeof db>;
