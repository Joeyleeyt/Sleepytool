// Combined lightweight-worker process.
//
// The orchestrator, 69labs (labs + tts), and veo3 workers are all I/O-bound
// BullMQ consumers — they spend almost all of their time waiting on external
// HTTP APIs (LLM, 69labs, Veo3) and DB/R2 round-trips, not on CPU. BullMQ
// multiplexes every Worker instance over a single shared Redis connection, so
// hosting all four in one Node process costs ~the same as running any one of
// them alone, while removing three otherwise-idle Fly machines.
//
// Each imported module instantiates its `new Worker(...)` as a top-level side
// effect, so importing them here is all that's needed to start them.
//
// The render worker is deliberately NOT included: it is CPU-bound, needs the
// ffmpeg image, a large VM, and a persistent volume, so it stays on its own
// machine (see infra/fly/sleepytool.fly.toml `render` process).
import '@emberforge/orchestrator';
import '@emberforge/labs-worker';
import '@emberforge/tts-worker';
import '@emberforge/veo3-worker';
