import { setDefaultTimeout } from 'bun:test'

/**
 * The deadline of every test and every hook of the suite.
 *
 * The default of the runtime is five seconds, and it applies to the hooks
 * as well. A `beforeAll` that starts a harness and launches a browser on a
 * cold machine can take longer than that: the hook times out, the tests of
 * its group are reported as one failure, and the run looks flaky while the
 * gateway is fine. A test that needs a longer deadline still names it.
 *
 * The file is preloaded by `bunfig.toml`, so every `bun test` of the
 * project, local or in the CI, runs with the same deadline.
 */
setDefaultTimeout(30_000)
