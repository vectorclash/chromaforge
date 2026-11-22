// The queue's runner (stock-runner.html, opened by scripts/ad-builder-queue.mjs in a headless
// Chromium): claims a job, renders it with the same loop the Stock master panel uses (stockJob.js),
// reports progress, and asks for the next one until the queue has nothing left, then says so and the
// server closes the browser. A job removed from the queue mid-render is cancelled at its next report.
import { renderStockJob, StockCancelled } from './stockJob';
import { queuePost } from './devApi';

const REPORT_MS = 500;

async function run() {
  for (;;) {
    const { job } = await queuePost('claim');
    if (!job) {
      await queuePost('idle');
      return;
    }
    let cancel = false;
    let last = 0;
    try {
      const done = await renderStockJob({
        ...job,
        cancelled: () => cancel,
        onProgress: ({ phase, frame, total, resets }) => {
          const now = performance.now();
          if (phase === 'rendering' && now - last < REPORT_MS && frame !== total) return;
          last = now;
          queuePost('progress', { id: job.id, phase, frame, total, resets })
            .then(r => r.cancel && (cancel = true))
            .catch(() => {});
        }
      });
      await queuePost('finished', { id: job.id, ...done });
    } catch (e) {
      console.error('[stock runner]', e);
      await queuePost('failed', { id: job.id, error: e instanceof StockCancelled ? 'cancelled' : e.message });
    }
  }
}

run().catch(e => console.error('[stock runner] stopped:', e));
