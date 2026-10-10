import test from 'node:test';
import assert from 'node:assert/strict';
import { polling } from '../web/polling.js';
test('polling coalesces refreshes, respects visibility and aborts on cleanup', async () => {
  let visible = true; let active = 0; let peak = 0; let calls = 0; let release!: () => void; let signal!: AbortSignal;
  const controller = polling(async current => { signal = current; calls++; active++; peak = Math.max(peak, active); await new Promise<void>(resolve => { release = resolve; }); active--; }, () => visible);
  const running = controller.refresh(); await controller.refresh(); await controller.refresh(); assert.equal(calls,1);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls,2); assert.equal(peak,1);
  release(); await running; visible=false; await controller.refresh(); assert.equal(calls,2);
  visible=true; const final=controller.refresh(); await controller.refresh(); controller.stop(); assert(signal.aborted); release(); await final; assert.equal(calls,3);
});
