import { writeFileSync } from 'node:fs';

export default class StubReporter {
  onEnd(result) {
    const status = result.status === 'passed' ? 'PASSED' : 'FAILED';
    console.log('[qualio] Results reported: http://stub.test/runs/run_' + (process.env.QUALIO_RUN_ROUND || '1'));
    if (status === 'FAILED') console.log('[qualio] Self-healing requested: Qualio will diagnose the failures and fix the tests if they are healable.');
    if (process.env.QUALIO_RUN_FILE)
      writeFileSync(process.env.QUALIO_RUN_FILE, JSON.stringify({ runId: 'run_1', status, url: 'http://stub.test/runs/run_1', heal: status === 'FAILED' ? 'queued' : null }));
  }
}
