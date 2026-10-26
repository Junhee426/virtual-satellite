// Runs the heavy model calls off the main thread so typing and dragging stay responsive.
import { focusMap, quantilePhaseRms, quantileCurve } from './physics.js?v=0.3.0';

const JOBS = { focusMap, quantilePhaseRms, quantileCurve };

self.onmessage = ({ data: { job, key, args } }) => {
  try {
    const result = JOBS[job](...args);
    self.postMessage({ job, key, result }, result?.values ? [result.values.buffer] : []);
  } catch (error) {
    self.postMessage({ job, key, error: String(error) });
  }
};
