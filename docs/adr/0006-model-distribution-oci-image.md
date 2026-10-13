# 0006. Laya model ships as a separate `brainstem-models` OCI image

- Status: Accepted
- Date: 2026-10-13

## Context

The core runs Laya evaluations through one serialized queue per process. The ~1.9 GB model cache is downloaded on first start into `data/laya-cache/` (`src/core/brainstem.mjs:52,322`).

In cluster mode, `core` pods are autoscaled on queue depth (KEDA). If every new pod downloads 1.9 GB before it can take work, autoscaling reacts too slowly to matter, and cold starts hit the model host on every scale-up. A shared volume would avoid the download, but ReadOnlyMany PVCs are unavailable on many clusters.

The model must also be pinned to a known version for each Brainstem release.

## Decision

The Laya model ships as a separate, versioned `brainstem-models` OCI image. The same CI pipeline publishes it alongside each release.

- **Kubernetes ≥1.31:** mounted as an image volume.
- **Older clusters:** an init container copies it into an `emptyDir`.
- **`role=all` / Docker:** the existing download-on-first-start cache in `data/laya-cache/` remains the default.

Inside a pod, the model is loaded once and shared by a `worker_threads` pool for Laya evaluation (roadmap §4.8).

## Alternatives considered

- **Download at startup (status quo)** — rejected for cluster mode. It ruins autoscaling speed. It stays the default for single-node.
- **ReadOnlyMany PVC with the model** — rejected. It is unavailable on many clusters, so it cannot be the supported path.

## Consequences

Positive:

- The image is cached per node by the container runtime, so there is no per-pod download on cold start.
- The model version is pinned and reproducible per release.
- Works on any cluster, with a fallback for clusters older than 1.31.
- Single-node UX is unchanged.

Negative:

- One more image to build, sign and publish in CI. Its size adds to node image pull time and storage.
- Two mount paths (image volume vs. init container) to keep in the Helm chart and test.

Follow-ups:

- Laya `worker_threads` pool; build and publish `brainstem-models` in CI (Phase 3).
- Helm chart image-volume / init-container templates; startup probe gated on the model being loaded (Phase 4).
- Measure cold-start and scale-up times in load tests (Phase 5).
