<?php
/**
 * The Status tab and `wp runova status`.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Info\StatusChecks;
use Runova\Connector\Tests\Support\TestCase;

final class StatusChecksTest extends TestCase
{
    /**
     * @return array<string, array{ok: bool|null, detail: string}>
     */
    private function checks(array $facts = array()): array
    {
        $out = array();
        foreach (StatusChecks::run($this->env, $this->storage, $facts) as $check) {
            $out[$check['id']] = array('ok' => $check['ok'], 'detail' => $check['detail']);
        }
        return $out;
    }

    public function testAHealthySite(): void
    {
        $this->makeSite();
        $this->env->put('mu-plugins/00-runova-connector-guard.php', '<?php');
        $checks = $this->checks(array('headerVersion' => '1.0.0', 'guardCurrent' => true));
        $this->assertSame(
            array('version', 'fileMods', 'filesystem', 'switches', 'loopback', 'guard', 'sodium', 'dataDir', 'syntax', 'https'),
            array_keys($checks)
        );
        foreach ($checks as $id => $check) {
            $this->assertTrue($check['ok'], $id . ': ' . $check['detail']);
        }
        $this->assertSame('1.0.0, protocol 1', $checks['version']['detail']);
        $this->assertSame('ok', $this->storage->kvGet('loopback', $this->env->now));
    }

    public function testProblemsAreNamed(): void
    {
        $this->makeSite();
        $this->env->fileModsAllowed = false;
        $this->env->filesystemMethod = 'ftpext';
        $this->env->constants['RUNOVA_CONNECTOR_DISABLED'] = true;
        $this->env->health = array(array(
            array('name' => 'home', 'status' => 500, 'ok' => false, 'detail' => 'HTTP 500'),
            array('name' => 'ajaxPing', 'status' => null, 'ok' => null, 'detail' => 'blocked'),
        ));
        $this->env->dataDir = '/nonexistent/runova/data';
        $checks = $this->checks(array('headerVersion' => '0.9.0', 'guardCurrent' => false));
        foreach (array('version', 'fileMods', 'filesystem', 'switches', 'loopback', 'guard', 'dataDir') as $id) {
            $this->assertFalse($checks[$id]['ok'], $id);
        }
        $this->assertStringContainsString('0.9.0', $checks['version']['detail']);
        $this->assertStringContainsString('DISALLOW_FILE_MODS', $checks['fileMods']['detail']);
        $this->assertStringContainsString('ftpext', $checks['filesystem']['detail']);
        $this->assertStringContainsString('home: HTTP 500', $checks['loopback']['detail']);
        $this->assertStringContainsString('Not installed', $checks['guard']['detail']);
        $this->assertSame('failed', $this->storage->kvGet('loopback', $this->env->now));
    }

    public function testNotesAreNeitherGoodNorBad(): void
    {
        $this->makeSite();
        $this->env->constants['RUNOVA_CONNECTOR_READ_ONLY'] = true;
        $this->env->health = array(array(array('name' => 'home', 'status' => null, 'ok' => null, 'detail' => 'blocked')));
        $checks = $this->checks();
        $this->assertNull($checks['switches']['ok']);
        $this->assertNull($checks['loopback']['ok']);
        $this->assertStringContainsString('READ_ONLY', $checks['switches']['detail']);
    }
}
