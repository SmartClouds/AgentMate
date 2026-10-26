<?php
/**
 * The deploy state table. B's fake connector mirrors it, so it is spelled out as data.
 *
 * States: open -> applying -> applied -> done; open -> aborted | expired (30 minutes idle);
 * applying | applied -> rolledBack(requested | healthCheck | fatalError | notConfirmed |
 * interrupted); done -> rolledBack(requested), only while its snapshot is kept and the files are
 * unchanged since (or with force).
 *
 * For each action and state the table says:
 *  - run: do the work (the result may still refuse, for example a commit with syntax errors
 *    leaves the deploy open);
 *  - same: change nothing and answer with the current state (repeat calls are safe);
 *  - invalid: an invalidState error that names the current state.
 *
 * What "run" does:
 *  - upload (open): stores chunks.
 *  - commit (open): validates; with any syntax error, conflict or refusal it stays open, else it
 *    becomes applying and applies. commit (applying): resumes. Ends in applied.
 *  - verify (applied): heartbeat and health checks; a regression rolls back (healthCheck).
 *  - finalize (applied): done. finalize never answers ok after a rollback.
 *  - rollback (open): aborted. (applying, applied): rolledBack(requested). (done): rolledBack
 *    when allowed, else the conflicts with the state still done.
 *  - abort (open): aborted. (applying, applied): rolledBack(requested).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Deploy;

final class StateMachine
{
    const STATES = array('open', 'applying', 'applied', 'done', 'rolledBack', 'aborted', 'expired');

    /** A deploy in one of these holds the site's deploy lock. */
    const ACTIVE = array('open', 'applying', 'applied');

    const REASONS = array('requested', 'healthCheck', 'fatalError', 'notConfirmed', 'interrupted');

    const TABLE = array(
        'upload' => array('open' => 'run', 'applying' => 'invalid', 'applied' => 'invalid', 'done' => 'invalid', 'rolledBack' => 'invalid', 'aborted' => 'invalid', 'expired' => 'invalid'),
        'commit' => array('open' => 'run', 'applying' => 'run', 'applied' => 'same', 'done' => 'same', 'rolledBack' => 'same', 'aborted' => 'same', 'expired' => 'same'),
        'verify' => array('open' => 'invalid', 'applying' => 'invalid', 'applied' => 'run', 'done' => 'same', 'rolledBack' => 'same', 'aborted' => 'same', 'expired' => 'same'),
        'finalize' => array('open' => 'invalid', 'applying' => 'invalid', 'applied' => 'run', 'done' => 'same', 'rolledBack' => 'invalid', 'aborted' => 'invalid', 'expired' => 'invalid'),
        'rollback' => array('open' => 'run', 'applying' => 'run', 'applied' => 'run', 'done' => 'run', 'rolledBack' => 'same', 'aborted' => 'same', 'expired' => 'same'),
        'abort' => array('open' => 'run', 'applying' => 'run', 'applied' => 'run', 'done' => 'invalid', 'rolledBack' => 'same', 'aborted' => 'same', 'expired' => 'same'),
    );

    /** run, same or invalid. */
    public static function decide(string $action, string $state): string
    {
        if (!isset(self::TABLE[$action][$state])) {
            throw new \InvalidArgumentException('Unknown action or state.');
        }
        return self::TABLE[$action][$state];
    }

    public static function isActive(string $state): bool
    {
        return in_array($state, self::ACTIVE, true);
    }
}
