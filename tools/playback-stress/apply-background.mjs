// Gives a stand-in job the same priority Lilin gives its own background jobs (src/priority.js).
// Use it as load.convert.apply in a config to test that policy.
import { background } from '../../src/priority.js';
export default async function apply(child) {
  background(child);
  await new Promise((r) => setTimeout(r, 1500)); // the helper starts on first use
}
