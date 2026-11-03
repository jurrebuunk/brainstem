/*
 * The plugin API lives in its own package, @brainstem-dev/sdk, so
 * plugins can depend on it without the runtime. Re-exported here so
 * `@brainstem-dev/brainstem/sdk` and the runtime keep one import path.
 */
export * from "@brainstem-dev/sdk";
