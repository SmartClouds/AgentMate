<?php
/**
 * The shared agent-files fixture: every hardDenied path is refused with pathRejected/hardDenied,
 * on its own and through /files/read; synced and ignoredUntracked paths are allowed.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Files\PathPolicy;
use Runova\Connector\Tests\Support\TestCase;

final class AgentFilesTest extends TestCase
{
    public function testPolicyRefusesEveryHardDeniedPath(): void
    {
        $fixture = self::agentFiles();
        $denied = 0;
        foreach ($fixture['files'] as $file) {
            $reason = PathPolicy::validate($file['path']);
            if ($file['expect'] === 'hardDenied') {
                $denied++;
                $this->assertSame('hardDenied', $reason, $file['path']);
            } else {
                // The plugin does not apply the desktop's default ignore list.
                $this->assertNull($reason, $file['path']);
            }
        }
        $this->assertGreaterThan(10, $denied);
    }

    public function testFilesReadRefusesEveryHardDeniedPath(): void
    {
        $this->makeSite();
        $fixture = self::agentFiles();
        $item = $fixture['item'];
        foreach ($fixture['files'] as $file) {
            $this->env->put('themes/' . $item['slug'] . '/' . $file['path'], 'x');
        }
        $connection = $this->connect();
        foreach ($fixture['files'] as $file) {
            if ($file['expect'] !== 'hardDenied') {
                continue;
            }
            $result = $this->call('/files/read', array('item' => $item, 'files' => array(array('path' => $file['path']))), array('connectionId' => $connection));
            $this->assertError('pathRejected', $result);
            $this->assertSame('hardDenied', $result['body']['error']['details']['reason'], $file['path']);
            $this->assertSame(0, $result['frame']->blobCount());
        }
    }

    public function testManifestLeavesHardDeniedFilesOut(): void
    {
        $this->makeSite();
        $fixture = self::agentFiles();
        $item = $fixture['item'];
        foreach ($fixture['files'] as $file) {
            $this->env->put('themes/' . $item['slug'] . '/' . $file['path'], 'x');
        }
        $data = $this->assertOk($this->call('/items/manifest', array('item' => $item), array('connectionId' => $this->connect())));
        $listed = array_column($data['entries'], 'path');
        foreach ($fixture['files'] as $file) {
            if ($file['expect'] === 'hardDenied') {
                $this->assertNotContains($file['path'], $listed);
            } else {
                $this->assertContains($file['path'], $listed);
            }
        }
        foreach ($data['skipped'] as $skip) {
            $this->assertSame('hardDenied', $skip['reason'], $skip['path']);
        }
    }
}
