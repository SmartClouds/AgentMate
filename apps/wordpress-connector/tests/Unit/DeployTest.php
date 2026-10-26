<?php
/**
 * The deploy transaction end to end on a fake site: apply, confirm, roll back, refuse.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Files\AtomicWriter;
use Runova\Connector\Tests\Support\DeployTestCase;

final class DeployTest extends DeployTestCase
{
    public function testFullDeployConfirmAndManualRollback(): void
    {
        $ops = $this->themeChange();
        $begin = $this->assertOk($this->begin($ops));
        $id = $begin['deployId'];
        $this->assertSame(array(), $begin['conflicts']);
        $this->assertSame(array(), $begin['refusals']);
        $this->assertSame('home', $begin['baseline'][0]['name']);
        $this->assertSame(1677721, $begin['limits']['maxRequestBytes']);
        $this->assertSame('open', $this->stateOf($id));
        $this->assertNull($this->env->guardState(), 'Nothing is guarded before files change.');

        $received = $this->assertOk($this->upload($id, $ops));
        $this->assertSame(array(array('op' => 0, 'nextOffset' => 11), array('op' => 1, 'nextOffset' => 12)), $received['received']);

        $commit = $this->assertOk($this->route('/deploy/commit', $id));
        $this->assertSame(array('state' => 'applied', 'progress' => array('done' => 3, 'total' => 3)), $commit);
        $this->assertSame('<?php // v2', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertSame('<?php // new', $this->read('themes/twentytwentyfive/inc/new/helper.php'));
        $this->assertNull($this->read('themes/twentytwentyfive/readme.txt'));
        $guard = $this->env->guardState();
        $this->assertSame($id, $guard['d']);
        $this->assertSame($this->env->now + 180, $guard['t']);
        $this->assertSame(array($this->path('themes/twentytwentyfive/functions.php'), $this->path('themes/twentytwentyfive/inc/new/helper.php')), $guard['f']);
        $this->assertContains($this->path('themes/twentytwentyfive/functions.php'), $this->env->invalidated);
        $this->assertGreaterThan(0, $this->env->cacheCleans);

        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertSame(array('deployId' => $id, 'state' => 'applied', 'deadline' => $this->env->now + 180), $info['pendingDeploy']);

        $this->env->now += 100;
        $verify = $this->assertOk($this->route('/deploy/verify', $id));
        $this->assertSame('applied', $verify['state']);
        $this->assertTrue($verify['healthy']);
        $this->assertSame($this->env->now + 180, $this->env->guardState()['t'], 'verify is a heartbeat');

        $this->assertSame(array('state' => 'done'), $this->assertOk($this->route('/deploy/finalize', $id)));
        $this->assertNull($this->env->guardState());
        $this->assertNull($this->storage->kvGet('deployLock', $this->env->now));
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertNull($info['pendingDeploy']);

        $history = $this->assertOk($this->call('/deploy/history', array('limit' => 5), array('connectionId' => $this->write)));
        $record = $history['deploys'][0];
        $this->assertSame($id, $record['deployId']);
        $this->assertSame('done', $record['state']);
        $this->assertSame(2, $record['puts']);
        $this->assertSame(1, $record['deletes']);
        $this->assertSame('Laptop', $record['connectionLabel']);
        $this->assertTrue($record['canRollback']);
        $this->assertArrayNotHasKey('reason', $record);

        $rollback = $this->assertOk($this->route('/deploy/rollback', $id));
        $this->assertSame(array('state' => 'rolledBack', 'reason' => 'requested', 'restored' => 2, 'removed' => 1), $rollback);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertSame('readme', $this->read('themes/twentytwentyfive/readme.txt'));
        $this->assertFalse(is_dir($this->path('themes/twentytwentyfive/inc')), 'Folders the deploy made are gone again.');

        $events = array_column($this->storage->audit, 'event');
        foreach (array('deployStarted', 'deployDone', 'deployRolledBack') as $event) {
            $this->assertContains($event, $events);
        }
    }

    public function testBeginWhileAnotherIsOpenIsBusy(): void
    {
        $first = $this->assertOk($this->begin($this->themeChange()))['deployId'];
        $result = $this->begin(array(self::put('plugin', 'akismet', 'x.php', '<?php', null)));
        $this->assertError('busy', $result, 409);
        $this->assertSame($first, $result['body']['error']['details']['deployId']);
    }

    public function testConflictsStopBeginUnlessForced(): void
    {
        $ops = array(self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2', str_repeat('a', 64)));
        $begin = $this->assertOk($this->begin($ops));
        $this->assertNull($begin['deployId']);
        $this->assertSame(array(array(
            'item' => array('kind' => 'theme', 'slug' => 'twentytwentyfive'),
            'path' => 'functions.php',
            'expected' => str_repeat('a', 64),
            'actual' => $this->sha('themes/twentytwentyfive/functions.php'),
        )), $begin['conflicts']);
        $this->assertNull($this->storage->kvGet('deployLock', $this->env->now));

        $forced = $this->assertOk($this->begin($ops, array(), true));
        $this->assertNotNull($forced['deployId']);
        $this->assertCount(1, $forced['conflicts']);

        // A file that must not exist yet, but does.
        $this->route('/deploy/abort', $forced['deployId']);
        $exists = $this->assertOk($this->begin(array(self::put('theme', 'twentytwentyfive', 'index.php', '<?php', null))));
        $this->assertNull($exists['deployId']);
        $this->assertNull($exists['conflicts'][0]['expected']);
    }

    public function testConflictAtCommitWhenTheSiteChangedAfterBegin(): void
    {
        $ops = array(self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2'));
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        file_put_contents($this->path('themes/twentytwentyfive/functions.php'), '<?php // someone else');
        $commit = $this->assertOk($this->route('/deploy/commit', $id));
        $this->assertSame('open', $commit['state']);
        $this->assertCount(1, $commit['conflicts']);
        $this->assertSame('<?php // someone else', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $id, array('force' => true)))['state']);
        $this->assertSame('<?php // v2', $this->read('themes/twentytwentyfive/functions.php'));
    }

    public function testRefusals(): void
    {
        $root = $this->env->content . '/themes/twentytwentyfive';
        mkdir($root . '/real');
        symlink($root . '/real', $root . '/linked');
        $ops = array(
            self::put('theme', 'twentytwentyfive', '../escape.php', 'x', null),
            self::put('theme', 'twentytwentyfive', 'linked/a.php', '<?php', null),
            self::put('theme', 'twentytwentyfive', 'style.css/inner.txt', 'x', null),
            self::put('theme', 'twentytwentyfive', 'real', 'x', null),
            self::put('plugin', 'runova-connector', 'evil.php', '<?php', null),
            self::put('plugin', 'missing', 'a.php', '<?php', null),
        );
        $begin = $this->assertOk($this->begin($ops));
        $this->assertNull($begin['deployId']);
        $reasons = array();
        foreach ($begin['refusals'] as $refusal) {
            $reasons[$refusal['path']] = $refusal['reason'];
            $this->assertFalse($refusal['forceable']);
        }
        $this->assertSame(array(
            '../escape.php' => 'traversal',
            'linked/a.php' => 'symlink',
            'style.css/inner.txt' => 'notWritable',
            'real' => 'notWritable',
            'evil.php' => 'itemProtected',
            'a.php' => 'itemUnknown',
        ), $reasons);
        // Force never overrides these.
        $this->assertNull($this->assertOk($this->begin($ops, array(), true))['deployId']);
    }

    public function testDenyListOnWrites(): void
    {
        $fixture = self::agentFiles();
        $ops = array();
        foreach ($fixture['files'] as $file) {
            if ($file['expect'] === 'hardDenied') {
                $ops[] = self::put('theme', 'twentytwentyfive', $file['path'], 'x', null);
            }
        }
        $begin = $this->assertOk($this->begin($ops, array(), true));
        $this->assertNull($begin['deployId']);
        $this->assertCount(count($ops), $begin['refusals']);
        foreach ($begin['refusals'] as $refusal) {
            $this->assertSame('hardDenied', $refusal['reason'], $refusal['path']);
        }
    }

    public function testNewItemsNeedCreate(): void
    {
        $ops = array(self::put('plugin', 'brand-new', 'brand-new.php', '<?php // new plugin', null));
        $this->assertSame('itemUnknown', $this->assertOk($this->begin($ops))['refusals'][0]['reason']);
        $begin = $this->assertOk($this->begin($ops, array(array('kind' => 'plugin', 'slug' => 'brand-new', 'create' => true))));
        $this->assertNotNull($begin['deployId']);
        $this->assertOk($this->upload($begin['deployId'], $ops));
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $begin['deployId']))['state']);
        $this->assertSame('<?php // new plugin', $this->read('plugins/brand-new/brand-new.php'));
        $this->assertOk($this->route('/deploy/rollback', $begin['deployId']));
        $this->assertFalse(file_exists($this->path('plugins/brand-new')), 'A created item folder goes away on rollback.');
    }

    public function testSingleFileItems(): void
    {
        $ops = array(self::put('plugin', 'hello.php', 'hello.php', '<?php // hello 2'));
        $id = $this->apply($ops);
        $this->assertSame('<?php // hello 2', $this->read('plugins/hello.php'));
        $this->assertOk($this->route('/deploy/rollback', $id));
        $this->assertSame('<?php // hello', $this->read('plugins/hello.php'));
        $wrong = $this->assertOk($this->begin(array(self::put('plugin', 'hello.php', 'other.php', '<?php', null))));
        $this->assertSame('traversal', $wrong['refusals'][0]['reason']);
    }

    public function testActiveCodeRefusalsCanBeForced(): void
    {
        $ops = array(
            self::delete('plugin', 'akismet', 'akismet.php'),
            self::delete('theme', 'twentytwentyfive', 'style.css'),
            self::delete('theme', 'twentytwentyfive', 'index.php'),
        );
        $begin = $this->assertOk($this->begin($ops));
        $this->assertNull($begin['deployId']);
        $this->assertSame(
            array('deletesActivePluginMainFile', 'touchesActiveThemeCore', 'touchesActiveThemeCore'),
            array_column($begin['refusals'], 'reason')
        );
        foreach ($begin['refusals'] as $refusal) {
            $this->assertTrue($refusal['forceable']);
        }
        // Writing to them is fine; only deleting is refused.
        $this->assertNotNull($this->assertOk($this->begin(array(self::put('theme', 'twentytwentyfive', 'style.css', '/* v2 */'))))['deployId']);
        $this->route('/deploy/abort', $this->storage->kvGet('deployLock', $this->env->now));
        $id = $this->apply($ops, true);
        $this->assertNull($this->read('plugins/akismet/akismet.php'));
        $this->assertOk($this->route('/deploy/rollback', $id));
        $this->assertSame('<?php // akismet', $this->read('plugins/akismet/akismet.php'));
    }

    public function testSyntaxErrorsAreNeverApplied(): void
    {
        $ops = array(self::put('theme', 'twentytwentyfive', 'functions.php', "<?php\nfunction broken( {\n"));
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        foreach (array(false, true) as $force) {
            $commit = $this->assertOk($this->route('/deploy/commit', $id, $force ? array('force' => true) : array()));
            $this->assertSame('open', $commit['state']);
            $this->assertSame('functions.php', $commit['syntaxErrors'][0]['path']);
            $this->assertSame(2, $commit['syntaxErrors'][0]['line']);
            $this->assertNotSame('', $commit['syntaxErrors'][0]['message']);
        }
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertSame(array('state' => 'aborted'), $this->assertOk($this->route('/deploy/abort', $id)));
        $this->assertNull($this->storage->kvGet('deployLock', $this->env->now));
    }

    public function testCommitBeforeUploadSaysWhatIsMissing(): void
    {
        $ops = $this->themeChange();
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $result = $this->route('/deploy/commit', $id);
        $this->assertError('badRequest', $result);
        $this->assertSame(array(0, 1), $result['body']['error']['details']['missing']);
        $this->assertSame('open', $this->stateOf($id));
    }

    public function testUploadInChunksAndRetries(): void
    {
        $content = str_repeat('chunky ', 100);
        $ops = array(self::put('theme', 'child', 'big.txt', $content, null));
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $send = function (int $offset, string $bytes, bool $final) use ($id) {
            return $this->call('/deploy/upload', array('deployId' => $id, 'chunks' => array(array('op' => 0, 'offset' => $offset, 'final' => $final))), array('connectionId' => $this->write, 'blobs' => array($bytes)));
        };
        $this->assertSame(300, $this->assertOk($send(0, substr($content, 0, 300), false))['received'][0]['nextOffset']);
        // A retry of the same chunk changes nothing.
        $this->assertSame(300, $this->assertOk($send(0, substr($content, 0, 300), false))['received'][0]['nextOffset']);
        $gap = $send(400, 'x', false);
        $this->assertError('badRequest', $gap);
        $this->assertSame(300, $gap['body']['error']['details']['nextOffset']);
        $this->assertError('badRequest', $send(300, substr($content, 300) . 'extra', true));
        $this->assertSame(700, $this->assertOk($send(300, substr($content, 300), true))['received'][0]['nextOffset']);
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $id))['state']);
        $this->assertSame($content, $this->read('themes/child/big.txt'));
    }

    public function testUploadWithTheWrongBytesStartsOver(): void
    {
        $ops = array(self::put('theme', 'child', 'a.txt', 'right', null));
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $result = $this->call('/deploy/upload', array('deployId' => $id, 'chunks' => array(array('op' => 0, 'offset' => 0, 'final' => true))), array('connectionId' => $this->write, 'blobs' => array('wrong')));
        $this->assertError('badRequest', $result);
        $this->assertSame(0, $result['body']['error']['details']['nextOffset']);
        $this->assertOk($this->upload($id, $ops));
    }

    public function testStagedContentNeedsNoSecondUpload(): void
    {
        $ops = array(
            self::put('theme', 'child', 'one.txt', 'shared', null),
            self::put('theme', 'child', 'two.txt', 'shared', null),
            self::put('theme', 'child', 'empty.txt', '', null),
        );
        $id = $this->assertOk($this->begin($ops))['deployId'];
        // Only the first copy is sent; the second has the same hash and the empty file needs nothing.
        $sent = $this->call('/deploy/upload', array('deployId' => $id, 'chunks' => array(array('op' => 0, 'offset' => 0, 'final' => true))), array('connectionId' => $this->write, 'blobs' => array('shared')));
        $this->assertOk($sent);
        $again = $this->assertOk($this->call('/deploy/upload', array('deployId' => $id, 'chunks' => array(array('op' => 1, 'offset' => 0, 'final' => false))), array('connectionId' => $this->write, 'blobs' => array(''))));
        $this->assertSame(array(array('op' => 1, 'nextOffset' => 6)), $again['received']);
        $this->assertSame('applied', $this->assertOk($this->route('/deploy/commit', $id))['state']);
        $this->assertSame('shared', $this->read('themes/child/two.txt'));
        $this->assertSame('', $this->read('themes/child/empty.txt'));
    }

    public function testHealthCheckRegressionRollsBack(): void
    {
        $id = $this->apply($this->themeChange());
        $this->env->health = array(array(
            array('name' => 'home', 'status' => 500, 'ok' => false, 'detail' => 'HTTP 500'),
            array('name' => 'ajaxPing', 'status' => 200, 'ok' => true, 'detail' => 'HTTP 200'),
        ));
        $verify = $this->assertOk($this->route('/deploy/verify', $id));
        $this->assertSame('rolledBack', $verify['state']);
        $this->assertFalse($verify['healthy']);
        $this->assertSame(500, $verify['checks'][0]['status']);
        $this->assertSame('healthCheck', $this->storage->getDeploy($id)['reason']);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $finalize = $this->route('/deploy/finalize', $id);
        $this->assertError('invalidState', $finalize, 409);
        $this->assertSame('rolledBack', $finalize['body']['error']['details']['state']);
        $this->assertSame('healthCheck', $finalize['body']['error']['details']['reason']);
    }

    public function testOnlyHealthyBeforeUnhealthyAfterCounts(): void
    {
        $this->env->health = array(
            array(
                array('name' => 'home', 'status' => null, 'ok' => null, 'detail' => 'loopback blocked'),
                array('name' => 'ajaxPing', 'status' => 401, 'ok' => null, 'detail' => 'sign-in'),
            ),
            array(
                array('name' => 'home', 'status' => 500, 'ok' => false, 'detail' => 'HTTP 500'),
                array('name' => 'ajaxPing', 'status' => 401, 'ok' => null, 'detail' => 'sign-in'),
            ),
        );
        $id = $this->apply($this->themeChange());
        $verify = $this->assertOk($this->route('/deploy/verify', $id));
        $this->assertSame('applied', $verify['state']);
        $this->assertNull($verify['healthy']);
    }

    public function testAFatalInALoopbackIsRolledBackByTheGuardThere(): void
    {
        $id = $this->apply($this->themeChange());
        $service = new DeployService($this->storage, $this->env, new AuditLog($this->storage));
        $this->env->onHealthCheck = function () use ($service) {
            // What the guard does in the loopback request that hit the fatal.
            $service->onFatal($this->path('themes/twentytwentyfive/functions.php'));
        };
        $verify = $this->assertOk($this->route('/deploy/verify', $id));
        $this->assertSame('rolledBack', $verify['state']);
        $this->assertFalse($verify['healthy']);
        $this->assertSame('fatalError', $this->storage->getDeploy($id)['reason']);
    }

    public function testFatalOnlyCountsInAChangedFile(): void
    {
        $id = $this->apply($this->themeChange());
        $service = new DeployService($this->storage, $this->env, new AuditLog($this->storage));
        $this->assertFalse($service->onFatal($this->path('plugins/akismet/akismet.php')));
        $this->assertSame('applied', $this->stateOf($id));
        $this->assertTrue($service->onFatal($this->path('themes/twentytwentyfive/inc/new/helper.php')));
        $this->assertSame('fatalError', $this->storage->getDeploy($id)['reason']);
        $this->assertNull($this->read('themes/twentytwentyfive/inc/new/helper.php'));
        $this->assertNull($this->env->guardState());
    }

    public function testUnconfirmedDeployRollsBackAtTheDeadline(): void
    {
        $id = $this->apply($this->themeChange());
        $this->env->now += 181;
        (new DeployService($this->storage, $this->env, new AuditLog($this->storage)))->checkPending();
        $this->assertSame('rolledBack', $this->stateOf($id));
        $this->assertSame('notConfirmed', $this->storage->getDeploy($id)['reason']);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
    }

    public function testHeartbeatsExtendTheDeadlineUpToFifteenMinutes(): void
    {
        $id = $this->apply($this->themeChange());
        $start = $this->env->now;
        for ($minute = 1; $minute <= 15; $minute++) {
            $this->env->now = $start + $minute * 60 - 30;
            $this->assertSame('applied', $this->assertOk($this->route('/deploy/verify', $id))['state']);
        }
        $this->assertSame($start + 900, $this->storage->getDeploy($id)['deadline']);
        $this->env->now = $start + 901;
        (new DeployService($this->storage, $this->env, new AuditLog($this->storage)))->checkPending();
        $this->assertSame('notConfirmed', $this->storage->getDeploy($id)['reason']);
    }

    public function testIdleOpenDeployExpires(): void
    {
        $id = $this->assertOk($this->begin($this->themeChange()))['deployId'];
        $this->env->now += 1801;
        $history = $this->assertOk($this->call('/deploy/history', array('limit' => 5), array('connectionId' => $this->write)));
        $this->assertSame('expired', $history['deploys'][0]['state']);
        $this->assertNotNull($this->assertOk($this->begin($this->themeChange()))['deployId'], 'The lock was freed.');
        $this->assertSame('expired', $this->stateOf($id));
    }

    public function testRollbackOfAFinishedDeployChecksForLaterChanges(): void
    {
        $id = $this->apply($this->themeChange());
        $this->assertOk($this->route('/deploy/finalize', $id));
        file_put_contents($this->path('themes/twentytwentyfive/functions.php'), '<?php // edited later');
        $history = $this->assertOk($this->call('/deploy/history', array('limit' => 5), array('connectionId' => $this->write)));
        $this->assertFalse($history['deploys'][0]['canRollback']);

        $result = $this->assertOk($this->route('/deploy/rollback', $id));
        $this->assertSame('done', $result['state']);
        $this->assertSame(0, $result['restored']);
        $this->assertSame('functions.php', $result['conflicts'][0]['path']);
        $this->assertSame(hash('sha256', '<?php // v2'), $result['conflicts'][0]['expected']);
        $this->assertSame('<?php // edited later', $this->read('themes/twentytwentyfive/functions.php'));

        $forced = $this->assertOk($this->route('/deploy/rollback', $id, array('force' => true)));
        $this->assertSame('rolledBack', $forced['state']);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
    }

    public function testOnlyFiveSnapshotsAndTwentyRecordsAreKept(): void
    {
        $ids = array();
        for ($index = 0; $index < 22; $index++) {
            $this->env->now += 10;
            $ids[] = $id = $this->apply(array(self::put('theme', 'child', 'n.txt', 'version ' . $index, $index === 0 ? null : 'current')));
            $this->assertOk($this->route('/deploy/finalize', $id));
        }
        $history = $this->assertOk($this->call('/deploy/history', array('limit' => 50), array('connectionId' => $this->write)));
        $this->assertCount(20, $history['deploys']);
        $kept = array_values(array_filter($history['deploys'], function ($record) {
            return $record['canRollback'];
        }));
        // Only the newest can roll back cleanly; older ones had n.txt changed by later deploys.
        $this->assertSame(array($ids[21]), array_column($kept, 'deployId'));
        $old = $this->route('/deploy/rollback', $ids[15], array('force' => true));
        $this->assertError('invalidState', $old);
        $this->assertSame('rolledBack', $this->assertOk($this->route('/deploy/rollback', $ids[17], array('force' => true)))['state']);
        $this->assertSame('version 16', $this->read('themes/child/n.txt'));
    }

    public function testWindowsRenameFallback(): void
    {
        $calls = 0;
        $this->writer = new AtomicWriter(function (string $from, string $to) use (&$calls): bool {
            $calls++;
            // Windows: renaming onto an existing file fails.
            if (file_exists($to)) {
                return false;
            }
            return rename($from, $to);
        });
        $id = $this->apply($this->themeChange());
        $this->assertSame('<?php // v2', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertGreaterThan(2, $calls);
        $this->assertOk($this->route('/deploy/rollback', $id));
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $leftovers = glob($this->path('themes/twentytwentyfive') . '/.runova-tmp-*');
        $this->assertSame(array(), $leftovers);
    }

    public function testAFailedWriteRollsEverythingBack(): void
    {
        $writes = 0;
        $this->writer = new AtomicWriter(function (string $from, string $to) use (&$writes): bool {
            // The second file fails both attempts (rename, then unlink and rename).
            $writes++;
            if ($writes === 2 || $writes === 3) {
                return false;
            }
            return rename($from, $to);
        });
        $ops = array(
            self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2'),
            self::put('theme', 'child', 'style.css', '/* child v2 */'),
        );
        $id = $this->assertOk($this->begin($ops))['deployId'];
        $this->assertOk($this->upload($id, $ops));
        $commit = $this->assertOk($this->route('/deploy/commit', $id));
        $this->assertSame('rolledBack', $commit['state']);
        $this->assertSame('interrupted', $this->storage->getDeploy($id)['reason']);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $this->assertSame('/* child */', $this->read('themes/child/style.css'));
        $rows = array_values(array_filter($this->storage->audit, function ($row) {
            return $row['event'] === 'deployRolledBack';
        }));
        $this->assertCount(1, $rows, 'One audit row per rollback.');
        $this->assertStringContainsString('The apply failed', $rows[0]['detail']);
    }

    public function testAbandonPendingRollsBackForDeactivation(): void
    {
        $service = new DeployService($this->storage, $this->env, new AuditLog($this->storage));
        $service->abandonPending('nothing pending');
        $id = $this->apply($this->themeChange());
        $service->abandonPending('The connector was deactivated.');
        $this->assertSame('interrupted', $this->storage->getDeploy($id)['reason']);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        $open = $this->assertOk($this->begin($this->themeChange()))['deployId'];
        $service->abandonPending('The connector was deactivated.');
        $this->assertSame('aborted', $this->stateOf($open));
    }

    public function testRescueRoutes(): void
    {
        $read = $this->connect('read');
        $id = $this->apply($this->themeChange());
        $status = $this->assertOk($this->call('/rescue/status', null, array('connectionId' => $read)));
        $this->assertSame(array('deployId' => $id, 'state' => 'applied', 'deadline' => $this->env->now + 180), $status['pending']);
        $this->assertNull($status['last']);
        $this->assertError('readOnly', $this->call('/rescue/rollback', array('deployId' => $id), array('connectionId' => $read)), 403);
        $this->assertSame(array('state' => 'rolledBack', 'reason' => 'requested'), $this->assertOk($this->route('/rescue/rollback', $id)));
        $status = $this->assertOk($this->call('/rescue/status', null, array('connectionId' => $read)));
        $this->assertNull($status['pending']);
        $this->assertSame('rolledBack', $status['last']['state']);
        $this->assertSame('requested', $status['last']['reason']);
    }

    public function testUnknownDeployAndBadIds(): void
    {
        $this->assertError('deployUnknown', $this->route('/deploy/commit', '00000000-0000-4000-8000-000000000000'), 404);
        $this->assertError('badRequest', $this->route('/deploy/commit', 'nope'));
    }

    public function testConcurrentCallsAreBusy(): void
    {
        $id = $this->assertOk($this->begin($this->themeChange()))['deployId'];
        $this->storage->kvAdd('deployMutex', 'someone-else', $this->env->now + 120, $this->env->now);
        $result = $this->route('/deploy/commit', $id);
        $this->assertError('busy', $result);
        $this->env->now += 121;
        $this->assertError('badRequest', $this->route('/deploy/commit', $id), 400);
    }
}
