import type { WorkerOptions } from 'bullmq';
import { connection } from './connection.js';

// Shared BullMQ Worker tuning. The default cadences are aimed at low-latency
// single-Redis setups; against a per-request-billed Redis (Upstash) they make
// every idle worker a steady background cost, 24/7, even with zero jobs:
//
//   drainDelay (default 5s)  — block timeout on the idle marker read. When the
//     queue is empty each worker re-issues this BZPOPMIN every `drainDelay`s.
//     New jobs still wake the blocking call immediately (via the marker), so
//     raising this does NOT add job-pickup latency — it only cuts the idle
//     wake-ups. 60s ⇒ 12× fewer idle reads per worker.
//
//   stalledInterval (default 30s) — how often the worker SCANs for jobs whose
//     lock expired (crashed mid-job). Active jobs renew their lock on their own
//     timer regardless of this, so it only governs crash-detection latency.
//     60s is fine for our minute-scale AI jobs and halves the scan traffic.
//
// Across the ~9 Worker instances in the combined `workers` process this is the
// difference between a constant idle Redis drain and near-silence when no video
// is being generated. Override per-worker by spreading and replacing fields.
export function workerOpts(overrides: Partial<WorkerOptions> = {}): WorkerOptions {
  return {
    connection,
    drainDelay: 60,
    stalledInterval: 60_000,
    ...overrides,
  };
}
