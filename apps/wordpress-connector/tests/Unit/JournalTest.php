<?php
/**
 * The apply journal: time-budgeted, resumable, and snapshot-before-apply.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Tests\Support\DeployTestCase;

final class JournalTest extends DeployTestCase
{
    /** @return array<int, array<string, mixed>> */
    private function manyOps(int $count): array
    {
        $ops = array();
        for ($index = 0; $index < $count; $index++) {
            $this->env->put('themes/child/f' . $index . '.txt', 'old ' . $index);
            $ops[] = self::put('theme', 'child', 'f' . $index . '.txt', 'new ' . $index);
        }
        return $ops;
    }

    public function testCommitResumesAcrossCallsAndSnapshotsEverythingFirst(): void
    {
        $ops = $this->manyOps(12);
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        // Each call gets through one step before its time budget runs out.
        $this->env->elapsedStep = 100.0;
        $calls = 0;
        $lastDone = -1;
        do {
            $this->env->elapsed = 0.0;
            $commit = $this->assertOk($this->route('/deploy/commit', $id));
            $calls++;
            $data = $this->dataOf($id);
            if ($data['journal']['phase'] === 'snapshot') {
                $this->assertSame('old 0', $this->read('themes/child/f0.txt'), 'Nothing changes before every snapshot is taken.');
            }
            $this->assertGreaterThanOrEqual($lastDone, $commit['progress']['done']);
            $lastDone = $commit['progress']['done'];
            $this->assertLessThan(40, $calls);
        } while ($commit['state'] === 'applying');
        $this->assertSame('applied', $commit['state']);
        $this->assertSame(array('done' => 12, 'total' => 12), $commit['progress']);
        $this->assertGreaterThan(20, $calls);
        for ($index = 0; $index < 12; $index++) {
            $this->assertSame('new ' . $index, $this->read('themes/child/f' . $index . '.txt'));
        }
        $this->assertCount(12, $this->dataOf($id)['snapshots']);
    }

    public function testReplayingStepsAfterACrashIsHarmless(): void
    {
        $ops = $this->manyOps(6);
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        $this->env->elapsedStep = 100.0;
        do {
            $this->env->elapsed = 0.0;
            $this->assertOk($this->route('/deploy/commit', $id));
            $data = $this->dataOf($id);
        } while (!($data['journal']['phase'] === 'apply' && $data['journal']['next'] >= 4));
        $this->assertSame('new 3', $this->read('themes/child/f3.txt'));
        // As if the process died before saving progress: the journal is behind the files.
        $data['journal']['next'] = 1;
        $this->storage->updateDeploy($id, array('data' => json_encode($data)));
        $this->env->elapsedStep = 0.0;
        $this->env->elapsed = 0.0;
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $id))['state']);
        for ($index = 0; $index < 6; $index++) {
            $this->assertSame('new ' . $index, $this->read('themes/child/f' . $index . '.txt'));
        }
        // The rollback still knows the original contents.
        $this->assertOk($this->route('/deploy/rollback', $id));
        for ($index = 0; $index < 6; $index++) {
            $this->assertSame('old ' . $index, $this->read('themes/child/f' . $index . '.txt'));
        }
    }

    public function testAStalledApplyIsRolledBackAsInterrupted(): void
    {
        $ops = $this->manyOps(6);
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        $this->env->elapsedStep = 100.0;
        do {
            $this->env->elapsed = 0.0;
            $this->assertOk($this->route('/deploy/commit', $id));
            $data = $this->dataOf($id);
        } while (!($data['journal']['phase'] === 'apply' && $data['journal']['next'] >= 3));
        $this->assertSame('applying', $this->stateOf($id));
        $this->assertSame('new 0', $this->read('themes/child/f0.txt'));
        // Nobody calls commit again; the deadline passes.
        $this->env->now += 181;
        (new DeployService($this->storage, $this->env, new AuditLog($this->storage)))->checkPending();
        $this->assertSame('rolledBack', $this->stateOf($id));
        $this->assertSame('interrupted', $this->storage->getDeploy($id)['reason']);
        for ($index = 0; $index < 6; $index++) {
            $this->assertSame('old ' . $index, $this->read('themes/child/f' . $index . '.txt'));
        }
    }
}
