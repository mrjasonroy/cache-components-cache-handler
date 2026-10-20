/**
 * Vitest setup: the handlers read the time from `Date.now()` in tests, so that
 * `vi.useFakeTimers` and `vi.setSystemTime` move it. At runtime they read the performance clock
 * (see `../shared/clock.ts`); `prerender-clock.test.ts` restores it.
 */

import { setClockForTests } from "../shared/clock.js";

setClockForTests(() => Date.now());
