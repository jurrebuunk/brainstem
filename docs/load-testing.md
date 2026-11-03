# Load testing

`scripts/load-test.mjs` measures what the pipeline itself costs: claims, commits, the delivery log and wakeups. It isolates that from Laya and from your destinations.

```sh
BRAINSTEM_LOAD_PG_URL=postgres://brainstem:secret@127.0.0.1:5432/brainstem \
  node scripts/load-test.mjs --jobs 2000 --cores 1,2,4 --concurrency 4,16 --delivery-ms 50
```

For each combination it creates a fresh schema and enqueues a burst of `--jobs` observations as decide jobs. It then starts the given number of core processes, which run `decide` and `deliver` with an instant decision and a destination that takes `--delivery-ms`. When the queue is empty it reports throughput and enqueue-to-delivered latency. Schemas are dropped afterwards.

## Results

A laptop (8 threads, Postgres 17 in Docker on the same machine), 2000 observations, a destination that takes 50 ms:

| cores | concurrency | drain (s) | decisions/s | deliveries/s | latency p50 (ms) | p95 (ms) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 4 | 32.7 | 200 | 61 | 17050 | 31624 |
| 1 | 16 | 8.8 | 637 | 226 | 5212 | 8913 |
| 2 | 4 | 16.6 | 329 | 121 | 8720 | 16115 |
| 2 | 16 | 4.9 | 991 | 411 | 3067 | 4985 |
| 4 | 4 | 9.1 | 540 | 221 | 5047 | 8947 |
| 4 | 16 | 3.1 | 1183 | 648 | 2162 | 3298 |

Latency is dominated by waiting in the burst. It shows how fast a backlog clears, not the latency of one envelope on an idle system, which is milliseconds plus the destination's own time.

What the numbers show:

- **Brainstem's own cost is about 15–20 ms per job** (a claim, the delivery-log write and the commit). Deliveries per second come out close to `cores × concurrency / (destination latency + ~15 ms)`.
- **Throughput scales almost linearly** with cores and concurrency until the machine runs out of CPU. At 4 × 16, the laptop running four cores and Postgres together was CPU-bound.
- **In production the queue is never the bottleneck.** Laya takes 50–200 ms per decision on a CPU, and destinations take tens of milliseconds (webhooks) to minutes (agents). Size for those.

## Sizing from the numbers

- **Deliver concurrency** (`runtime.queue.deliver.concurrency`, default 4): deliveries are I/O-bound, so a core handles about `concurrency / destination latency` per second. Raise it for slow webhooks, for example 16 for a 200 ms receiver. Keep it low when a receiver has rate limits, such as a model API with tight quotas.
- **Decide concurrency** (`--decide-concurrency`): CPU-bound, so roughly one worker per CPU you give the pod, and about 0.5 GB of memory each.
- **KEDA `readyPerReplica`** (default 20): one replica per *N* due jobs. Pick *N* ≈ one replica's throughput × the backlog you accept in seconds.
  - A deliver replica at concurrency 4 against a 200 ms receiver does ~20/s, so 20 means about one second of backlog per replica.
  - For slow agent destinations the backlog is better measured as **age**: `oldestAgeSeconds` (default 60) adds a replica per minute the oldest job has waited.
- **Failover**: a crashed core's work moves on within about 20 s (3 heartbeats of 5 s, plus a reclaim scan that runs at least every 5 s). A shorter `runtime.cores.heartbeatMs` shortens it, at the cost of one UPDATE per core per heartbeat.

Re-run the script on your own hardware and Postgres, with `--delivery-ms` set to your slowest destination, before you pick the numbers.
