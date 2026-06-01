/**
 * Convenience script: read a transcript file from disk and POST it to the API.
 *
 *   pnpm tsx scripts/submit-transcript.ts ./samples/my-transcript.txt "My Doc"
 *
 * Prints the projectId and polls /v1/projects/:id until status reaches a
 * terminal state ('published' or 'failed').
 */
import { readFile } from 'node:fs/promises';

const [, , filePath, title] = process.argv;
if (!filePath) {
  console.error('usage: submit-transcript <transcript.txt> [title]');
  process.exit(1);
}

// API now lives in the Next.js app under /api/v1/* (port 3000 in dev).
const API = process.env.EMBERFORGE_API ?? 'http://localhost:3000';
const transcript = await readFile(filePath, 'utf8');

const create = await fetch(`${API}/api/v1/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    title: title ?? `transcript-${Date.now()}`,
    transcript,
  }),
});
if (!create.ok) {
  console.error('create failed:', create.status, await create.text());
  process.exit(1);
}
const { projectId } = (await create.json()) as { projectId: string };
console.log('projectId:', projectId);

const TERMINAL = new Set(['published', 'failed']);
while (true) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await fetch(`${API}/api/v1/projects/${projectId}`);
  const p = (await r.json()) as { status: string };
  console.log(new Date().toISOString(), 'status:', p.status);
  if (TERMINAL.has(p.status)) {
    process.exit(p.status === 'published' ? 0 : 1);
  }
}
