/**
 * Planner route.
 *
 * `warmPlannerCaches()` used to run at app start, where it parsed ~25MB of
 * JSON (route stops ≈15MB, routes-for-stop ≈7MB, schedules ≈4MB) on the JS
 * thread while the user was looking at the home screen — 1.5–4s of dropped
 * frames and 100–200MB resident for a screen most sessions never open.
 *
 * Running it here means the cost lands on the one navigation that needs it,
 * overlapping the screen transition instead of the cold start.
 */

import React, { useEffect } from 'react';
import PlannerScreen from '../src/features/planner/PlannerScreen';
import { warmPlannerCaches } from '../src/services/storage';

/** Module-scoped: the caches are process-wide, so re-entering the planner
 *  must not re-read 25MB of files. Reset on failure so a transient read
 *  error doesn't disable the warm-up for the rest of the session. */
let _warming: Promise<void> | null = null;

export default function Planner() {
  useEffect(() => {
    if (_warming) return;
    // Fire-and-forget. The screen reads through the same caches, so nothing
    // here has to be awaited — a cold read just pays the file cost inline.
    _warming = warmPlannerCaches().catch((err) => {
      console.warn('[planner] cache warm-up failed:', err);
      _warming = null;
    });
  }, []);

  return <PlannerScreen />;
}
