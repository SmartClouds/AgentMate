<?php
/**
 * The full state table: every action in every state, through the real service.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Deploy\StateMachine;
use Runova\Connector\Tests\Support\DeployTestCase;

final class StateMachineTest extends DeployTestCase
{
    /**
     * action => state => expected answer: a state name for ok, or 'invalidState'.
     */
    const EXPECTED = array(
        'upload' => array('open' => 'open', 'applying' => 'invalidState', 'applied' => 'invalidState', 'done' => 'invalidState', 'rolledBack' => 'invalidState', 'aborted' => 'invalidState', 'expired' => 'invalidState'),
        'commit' => array('open' => 'applied', 'applying' => 'applied', 'applied' => 'applied', 'done' => 'done', 'rolledBack' => 'rolledBack', 'aborted' => 'aborted', 'expired' => 'expired'),
        'verify' => array('open' => 'invalidState', 'applying' => 'invalidState', 'applied' => 'applied', 'done' => 'done', 'rolledBack' => 'rolledBack', 'aborted' => 'aborted', 'expired' => 'expired'),
        'finalize' => array('open' => 'invalidState', 'applying' => 'invalidState', 'applied' => 'done', 'done' => 'done', 'rolledBack' => 'invalidState', 'aborted' => 'invalidState', 'expired' => 'invalidState'),
        'rollback' => array('open' => 'aborted', 'applying' => 'rolledBack', 'applied' => 'rolledBack', 'done' => 'rolledBack', 'rolledBack' => 'rolledBack', 'aborted' => 'aborted', 'expired' => 'expired'),
        'abort' => array('open' => 'aborted', 'applying' => 'rolledBack', 'applied' => 'rolledBack', 'done' => 'invalidState', 'rolledBack' => 'rolledBack', 'aborted' => 'aborted', 'expired' => 'expired'),
    );

    /**
     * @return array<string, array{0: string, 1: string}>
     */
    public function cases(): array
    {
        $cases = array();
        foreach (self::EXPECTED as $action => $states) {
            foreach (array_keys($states) as $state) {
                $cases[$action . ' in ' . $state] = array($action, $state);
            }
        }
        return $cases;
    }

    public function testTableCoversEveryActionAndState(): void
    {
        foreach (StateMachine::TABLE as $action => $states) {
            $this->assertSame(StateMachine::STATES, array_keys($states), $action);
            foreach ($states as $state => $decision) {
                $this->assertContains($decision, array('run', 'same', 'invalid'));
                $this->assertSame($decision === 'invalid', self::EXPECTED[$action][$state] === 'invalidState', "$action in $state");
            }
        }
    }

    /**
     * @dataProvider cases
     */
    public function testActionInState(string $action, string $state): void
    {
        $ops = $this->themeChange();
        $id = $this->reach($state, $ops);
        $this->assertSame($state, $this->stateOf($id));
        $before = $this->storage->getDeploy($id)['reason'];

        $result = $this->act($action, $id, $ops);
        $expected = self::EXPECTED[$action][$state];
        if ($expected === 'invalidState') {
            $this->assertError('invalidState', $result, 409);
            $this->assertSame($state, $result['body']['error']['details']['state']);
            $this->assertSame($state, $this->stateOf($id), 'An invalid call changes nothing.');
            return;
        }
        $data = $this->assertOk($result);
        if ($action === 'upload') {
            $this->assertSame(array(array('op' => 0, 'nextOffset' => strlen($ops[0]['_content']))), $data['received']);
        } else {
            $this->assertSame($expected, $data['state'], json_encode($data));
        }
        $this->assertSame($expected, $this->stateOf($id));
        if ($expected === 'rolledBack' && $state !== 'rolledBack') {
            $this->assertSame('requested', $this->storage->getDeploy($id)['reason']);
            $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        }
        if ($state === $expected) {
            $this->assertSame($before, $this->storage->getDeploy($id)['reason'], 'Repeat calls are safe.');
        }
        if (!StateMachine::isActive($expected)) {
            $this->assertNull($this->storage->kvGet('deployLock', $this->env->now), 'A finished deploy holds no lock.');
        }
    }

    /**
     * @param array<int, array<string, mixed>> $ops
     */
    private function reach(string $state, array $ops): string
    {
        $id = $this->assertOk($this->begin($ops))['deployId'];
        if ($state === 'aborted') {
            $this->assertOk($this->route('/deploy/abort', $id));
            return $id;
        }
        if ($state === 'expired') {
            $this->env->now += 1801;
            $this->assertOk($this->call('/deploy/history', array('limit' => 1), array('connectionId' => $this->write)));
            return $id;
        }
        $this->assertOk($this->upload($id, $ops));
        if ($state === 'open') {
            return $id;
        }
        if ($state === 'applying') {
            $this->env->elapsedStep = 100.0;
            $this->assertSame('applying', $this->assertOk($this->route('/deploy/commit', $id))['state']);
            $this->env->elapsedStep = 0.0;
            $this->env->elapsed = 0.0;
            return $id;
        }
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $id))['state']);
        if ($state === 'done') {
            $this->assertOk($this->route('/deploy/finalize', $id));
        } elseif ($state === 'rolledBack') {
            $this->assertOk($this->route('/deploy/rollback', $id));
        }
        return $id;
    }

    /**
     * @param array<int, array<string, mixed>> $ops
     * @return array<string, mixed>
     */
    private function act(string $action, string $id, array $ops): array
    {
        if ($action === 'upload') {
            return $this->call('/deploy/upload', array('deployId' => $id, 'chunks' => array(array('op' => 0, 'offset' => 0, 'final' => true))), array('connectionId' => $this->write, 'blobs' => array($ops[0]['_content'])));
        }
        return $this->route('/deploy/' . $action, $id);
    }
}
