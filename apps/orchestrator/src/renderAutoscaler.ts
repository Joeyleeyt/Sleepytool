import os from 'node:os';
import type { Logger } from 'pino';
import { connection, queues } from '@emberforge/queue';

/**
 * Render autoscaler — starts/stops a SECOND render machine on demand so two long
 * videos can render at the same time, then scales back to one when idle.
 *
 * Why this exists: the render worker is fixed at concurrency 1 and tuned to use a
 * whole machine (all cores, all 16gb RAM, the 50gb volume), so two renders must
 * run on two separate machines. Fly's built-in autostop/autostart is
 * traffic-based and can't see a Redis queue consumer, so we drive the Fly
 * Machines API ourselves off the `render` queue depth.
 *
 * Logic (polled every RENDER_AUTOSCALE_POLL_MS):
 *   demand = render queue waiting + active + delayed
 *   demand >= START_THRESHOLD (2) -> start the secondary machine
 *   demand == 0                   -> stop it  (guaranteed idle: no render in flight)
 *   in between (exactly 1)        -> leave as-is  (never kills a running render)
 *
 * The always-on PRIMARY render machine is never touched — only the secondary
 * (RENDER_SECONDARY_MACHINE_ID). Only the leader runs the loop (a Redis lease),
 * so the two `workers` machines don't both call the API. Flag-gated
 * (RENDER_AUTOSCALE_ENABLED, default off) for a safe rollout.
 */

const ENABLED = (process.env.RENDER_AUTOSCALE_ENABLED ?? 'false') === 'true';
const APP = process.env.FLY_APP_NAME ?? 'sleepytool';
const TOKEN = process.env.FLY_API_TOKEN ?? '';
const MACHINE_ID = process.env.RENDER_SECONDARY_MACHINE_ID ?? '';
const API = process.env.FLY_MACHINES_API ?? 'https://api.machines.dev';
const POLL_MS = Math.max(5_000, Number(process.env.RENDER_AUTOSCALE_POLL_MS ?? 20_000));
// Start the secondary only when a SECOND render is queued (the always-on primary
// handles a lone render). >=2 by construction; clamp so a misconfig can't make it
// scale on a single render.
const START_THRESHOLD = Math.max(2, Number(process.env.RENDER_AUTOSCALE_START_THRESHOLD ?? 2));

// Leader election: whichever workers instance holds this lease runs the loop.
const LEADER_KEY = 'render-autoscaler:leader';
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
// Lease outlives a few polls so a single slow tick doesn't hand off leadership.
const LEASE_MS = POLL_MS * 3;

/** True if THIS instance currently holds (or just took) the autoscaler lease. */
async function isLeader(): Promise<boolean> {
  const current = await connection.get(LEADER_KEY);
  if (current === INSTANCE_ID) {
    // We own it — refresh the lease.
    await connection.set(LEADER_KEY, INSTANCE_ID, 'PX', LEASE_MS);
    return true;
  }
  if (current === null) {
    // Free — try to claim atomically; only one instance's NX wins.
    const ok = await connection.set(LEADER_KEY, INSTANCE_ID, 'PX', LEASE_MS, 'NX');
    return ok === 'OK';
  }
  return false; // someone else leads
}

async function flyFetch(suffix: string, method: 'GET' | 'POST'): Promise<Response> {
  return fetch(`${API}/v1/apps/${APP}/machines/${MACHINE_ID}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
}

/** Current Fly state of the secondary machine ('started' | 'stopped' | …), or null. */
async function machineState(): Promise<string | null> {
  const res = await flyFetch('', 'GET');
  if (!res.ok) throw new Error(`fly GET machine ${res.status}`);
  const body = (await res.json()) as { state?: string };
  return body.state ?? null;
}

/** Bring the secondary to the wanted state, but only call the API if it differs. */
async function ensure(want: 'start' | 'stop', log: Logger): Promise<void> {
  const state = await machineState();
  const running = state === 'started';
  if (want === 'start' && !running) {
    const res = await flyFetch('/start', 'POST');
    log.info(
      { machineId: MACHINE_ID, fromState: state, status: res.status },
      '[render-autoscale] starting secondary render machine (2+ renders queued)',
    );
  } else if (want === 'stop' && running) {
    const res = await flyFetch('/stop', 'POST');
    log.info(
      { machineId: MACHINE_ID, fromState: state, status: res.status },
      '[render-autoscale] stopping secondary render machine (render queue empty)',
    );
  }
}

async function tick(log: Logger): Promise<void> {
  if (!(await isLeader())) return;
  const c = await queues.render.getJobCounts('waiting', 'active', 'delayed');
  const demand = (c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0);
  if (demand >= START_THRESHOLD) await ensure('start', log);
  else if (demand === 0) await ensure('stop', log);
  // demand === 1 → leave as-is: the lone render may be on the secondary, so we
  // must not stop it; the primary covers a single render once the secondary idles.
}

/**
 * Start the render autoscaler loop. Call once from the orchestrator boot (it runs
 * inside the always-on `workers` process). No-op unless RENDER_AUTOSCALE_ENABLED.
 */
export function startRenderAutoscaler(log: Logger): void {
  if (!ENABLED) {
    log.info('[render-autoscale] disabled (set RENDER_AUTOSCALE_ENABLED=true to enable)');
    return;
  }
  if (!TOKEN || !MACHINE_ID) {
    log.warn(
      '[render-autoscale] enabled but FLY_API_TOKEN or RENDER_SECONDARY_MACHINE_ID is missing — not starting',
    );
    return;
  }
  log.info(
    { app: APP, machineId: MACHINE_ID, pollMs: POLL_MS, startThreshold: START_THRESHOLD },
    '[render-autoscale] started — scaling the secondary render machine off render queue depth',
  );
  const timer = setInterval(() => {
    void tick(log).catch((err) =>
      log.error({ err: (err as Error).message }, '[render-autoscale] tick failed'),
    );
  }, POLL_MS);
  // Never keep the process alive just for this timer.
  timer.unref?.();
}
