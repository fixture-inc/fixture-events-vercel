import { readFile } from 'node:fs/promises';
import { db } from '../lib/db';

const sql = db();
try {
  await sql.unsafe(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
  console.log('Inbox schema is ready.');
} finally {
  await sql.end();
}
