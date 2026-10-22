<?php
/**
 * /connector/update: the app sends a newer release, or has the site download it from the GitHub
 * release, and the plugin swaps its own folder.
 *
 * @package AgentMate\Connector
 */

namespace AgentMate\Connector\Tests\Unit;

use AgentMate\Connector\Deploy\DeployService;
use AgentMate\Connector\Tests\Support\DeployTestCase;
use AgentMate\Connector\Tests\Support\ZipFixture;

final class ConnectorUpdateTest extends DeployTestCase
{
    const OLD = '1.0.0';
    const NEW = '1.1.0';

    protected function setUp(): void
    {
        parent::setUp();
        $this->install(self::OLD);
    }

    /** The connector folder the fake site "runs": a release plus the file the plugin writes itself. */
    private function install(string $version): void
    {
        $dir = $this->path('plugins/agentmate-connector');
        if (is_dir($dir)) {
            $this->wipe($dir);
        }
        foreach ($this->release($version) as $relative => $bytes) {
            $this->env->put('plugins/agentmate-connector/' . $relative, $bytes);
        }
        $this->env->put('plugins/agentmate-connector/rescue-config.php', "<?php\nreturn array('abspath' => '/site/');\n");
    }

    private function wipe(string $dir): void
    {
        foreach ((array) scandir($dir) as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $path = $dir . '/' . $name;
            if (is_dir($path) && !is_link($path)) {
                $this->wipe($path);
            } else {
                unlink($path);
            }
        }
        rmdir($dir);
    }

    /**
     * The files of a release, by path.
     *
     * @return array<string, string>
     */
    private function release(string $version, string $php = '7.4', string $wp = '6.0'): array
    {
        return array(
            'agentmate-connector.php' => "<?php\n/**\n * Plugin Name:       AgentMate Connector\n * Version:           {$version}\n * Requires at least: {$wp}\n * Requires PHP:      {$php}\n */\ndefine('AGENTMATE_CONNECTOR_VERSION', '{$version}');\n",
            'src/Autoloader.php' => "<?php // autoloader {$version}\n",
            'src/Plugin.php' => "<?php // plugin {$version}\n",
            'src/Util/Helper.php' => "<?php // helper {$version}\n",
            'guard/00-agentmate-connector-guard.php' => "<?php // guard {$version}\n",
            'readme.txt' => "=== AgentMate Connector ===\nStable tag: {$version}\n",
        );
    }

    /**
     * The request body for a release.
     *
     * @param array<string, string> $files
     * @return array{version: string, files: array<int, array<string, mixed>>}
     */
    private function body(array $files, string $version = self::NEW): array
    {
        $entries = array();
        foreach ($files as $path => $bytes) {
            $entries[] = array('path' => $path, 'size' => strlen($bytes), 'sha256' => hash('sha256', $bytes));
        }
        return array('version' => $version, 'files' => $entries);
    }

    /**
     * @param array<string, string> $files
     * @param array<string, mixed>|null $body overrides the body built from $files
     * @param string[]|null $blobs overrides the blobs
     * @return array<string, mixed> the call result
     */
    private function update(array $files, string $version = self::NEW, ?array $body = null, ?array $blobs = null, ?string $connection = null): array
    {
        return $this->call(
            '/connector/update',
            $body !== null ? $body : $this->body($files, $version),
            array('connectionId' => $connection === null ? $this->write : $connection, 'blobs' => $blobs !== null ? $blobs : array_values($files))
        );
    }

    /** @return string[] dot folders beside the plugins */
    private function siblings(): array
    {
        return array_values(array_filter((array) scandir($this->path('plugins')), function ($name) {
            return strncmp((string) $name, '.agentmate-connector-', 21) === 0;
        }));
    }

    private function installed(string $relative): ?string
    {
        return $this->read('plugins/agentmate-connector/' . $relative);
    }

    /** @param array<string, mixed> $result */
    private function assertRefused(string $reason, array $result): void
    {
        $this->assertError('updateRefused', $result, 422);
        $this->assertSame($reason, $result['body']['error']['details']['reason'], (string) json_encode($result['body']));
        $this->assertNotSame('', $result['body']['error']['message']);
        $this->assertSame(self::OLD, $this->versionOnDisk(), 'The old connector is still in place.');
        $this->assertSame(array(), $this->siblings(), 'No folder is left beside the plugin.');
    }

    private function versionOnDisk(): string
    {
        preg_match('/Version:\s+(\S+)/', (string) $this->installed('agentmate-connector.php'), $match);
        return $match[1];
    }

    private function health(bool $home, ?bool $ping = true): array
    {
        return array(
            array('name' => 'home', 'status' => $home ? 200 : 500, 'ok' => $home, 'detail' => $home ? 'HTTP 200' : 'HTTP 500'),
            array('name' => 'ajaxPing', 'status' => $ping === null ? null : 200, 'ok' => $ping, 'detail' => 'HTTP 200'),
        );
    }

    public function testReplacesTheFolder(): void
    {
        $release = $this->release(self::NEW);
        $data = $this->assertOk($this->update($release));

        $this->assertSame('updated', $data['state']);
        $this->assertSame(self::OLD, $data['fromVersion']);
        $this->assertSame(self::NEW, $data['version']);
        $this->assertSame(count($release), $data['files']);
        $this->assertCount(2, $data['checks']);
        foreach ($release as $path => $bytes) {
            $this->assertSame($bytes, $this->installed($path), $path);
        }
        $this->assertSame(self::NEW, $this->versionOnDisk());
        $this->assertSame(array(), $this->siblings());
        $this->assertSame(2, $this->env->healthCalls, 'Once before the swap and once after.');
        $this->assertGreaterThanOrEqual(1, $this->env->cacheCleans);
        $this->assertContains($this->path('plugins/agentmate-connector/src/Plugin.php'), $this->env->invalidated);
        $this->assertNotContains($this->path('plugins/agentmate-connector/readme.txt'), $this->env->invalidated);
    }

    public function testKeepsTheFilesThePluginWritesForItself(): void
    {
        $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertSame("<?php\nreturn array('abspath' => '/site/');\n", $this->installed('rescue-config.php'));
    }

    public function testRemovesFilesTheNewReleaseNoLongerHas(): void
    {
        $this->env->put('plugins/agentmate-connector/src/Old/Gone.php', '<?php // gone');
        $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertNull($this->installed('src/Old/Gone.php'));
        $this->assertFalse(is_dir($this->path('plugins/agentmate-connector/src/Old')));
    }

    public function testWritesTheAuditLog(): void
    {
        $this->assertOk($this->update($this->release(self::NEW)));
        $entries = array_values(array_filter($this->storage->listAudit(50, null), function ($row) {
            return $row['event'] === 'connectorUpdated';
        }));
        $this->assertCount(1, $entries);
        $this->assertStringContainsString('from ' . self::OLD . ' to ' . self::NEW, $entries[0]['detail']);
        $this->assertSame('Laptop', $entries[0]['connection_label']);
    }

    public function testTheSameVersionCanBeInstalledAgain(): void
    {
        $data = $this->assertOk($this->update($this->release(self::OLD), self::OLD));
        $this->assertSame('updated', $data['state']);
    }

    public function testPutsTheOldFolderBackWhenTheSiteFailsItsHealthCheck(): void
    {
        $this->env->health = array($this->health(true), $this->health(false));
        $data = $this->assertOk($this->update($this->release(self::NEW)));

        $this->assertSame('rolledBack', $data['state']);
        $this->assertSame(self::OLD, $data['fromVersion']);
        $this->assertSame(self::NEW, $data['version']);
        $this->assertFalse($data['checks'][0]['ok']);
        $this->assertSame(self::OLD, $this->versionOnDisk());
        $this->assertSame("<?php\nreturn array('abspath' => '/site/');\n", $this->installed('rescue-config.php'));
        $this->assertSame(array(), $this->siblings());
        $events = array_column($this->storage->listAudit(50, null), 'event');
        $this->assertContains('connectorRolledBack', $events);
        $this->assertNotContains('connectorUpdated', $events);
    }

    public function testAHealthCheckThatCouldNotRunIsNotAFailure(): void
    {
        $this->env->health = array($this->health(true, null), $this->health(true, null));
        $data = $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertSame('updated', $data['state']);
    }

    public function testACheckThatWasAlreadyFailingDoesNotBlockTheUpdate(): void
    {
        $this->env->health = array($this->health(false), $this->health(false));
        $data = $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertSame('updated', $data['state']);
    }

    public function testRefusesAnOlderRelease(): void
    {
        $this->install('1.5.0');
        $this->env->pluginVersion = '1.5.0';
        $result = $this->update($this->release('1.4.0'), '1.4.0');
        $this->assertError('updateRefused', $result, 422);
        $this->assertSame('downgrade', $result['body']['error']['details']['reason']);
        $this->assertStringContainsString('1.5.0', $result['body']['error']['message']);
        $this->assertSame('1.5.0', $this->versionOnDisk());
        $this->assertSame(array(), $this->siblings());
    }

    public function testRefusesAReleaseThatNeedsANewerPhpOrWordPress(): void
    {
        $this->assertRefused('requirements', $this->update($this->release(self::NEW, '99.0')));
        $this->assertRefused('requirements', $this->update($this->release(self::NEW, '7.4', '99.0')));
        $this->assertSame(0, $this->env->healthCalls, 'Nothing was staged or checked.');
    }

    public function testRefusesASyntaxErrorBeforeWritingAnything(): void
    {
        $release = $this->release(self::NEW);
        $release['src/Util/Helper.php'] = "<?php\nfunction (\n";
        $result = $this->update($release);
        $this->assertError('syntaxError', $result, 422);
        $this->assertSame('src/Util/Helper.php', $result['body']['error']['details']['path']);
        $this->assertGreaterThanOrEqual(2, $result['body']['error']['details']['line']);
        $this->assertSame(self::OLD, $this->versionOnDisk());
        $this->assertSame(array(), $this->siblings());
        $this->assertSame(0, $this->env->healthCalls);
    }

    /**
     * @return array<string, array{0: callable}>
     */
    public function badPackages(): array
    {
        $change = function (callable $edit) {
            return function (array $release) use ($edit): array {
                return $edit($release);
            };
        };
        return array(
            'a traversal path' => array($change(function (array $r) {
                $r['../evil.php'] = '<?php';
                return $r;
            })),
            'a hidden agent file' => array($change(function (array $r) {
                $r['.claude/settings.json'] = '{}';
                return $r;
            })),
            'an env file' => array($change(function (array $r) {
                $r['src/.env'] = 'A=1';
                return $r;
            })),
            'a file type the connector never ships' => array($change(function (array $r) {
                $r['src/run.exe'] = 'MZ';
                return $r;
            })),
            'a backslash path' => array($change(function (array $r) {
                $r['src\\Evil.php'] = '<?php';
                return $r;
            })),
            'the file the plugin writes itself' => array($change(function (array $r) {
                $r['rescue-config.php'] = '<?php return array();';
                return $r;
            })),
            'the same path in another case' => array($change(function (array $r) {
                $r['SRC/PLUGIN.PHP'] = '<?php // again';
                return $r;
            })),
            'a file inside a file' => array($change(function (array $r) {
                $r['readme.txt/inner.txt'] = 'x';
                return $r;
            })),
            'no autoloader' => array($change(function (array $r) {
                unset($r['src/Autoloader.php']);
                return $r;
            })),
            'no guard template' => array($change(function (array $r) {
                unset($r['guard/00-agentmate-connector-guard.php']);
                return $r;
            })),
            'another plugin' => array($change(function (array $r) {
                $r['agentmate-connector.php'] = str_replace('AgentMate Connector', 'Something Else', $r['agentmate-connector.php']);
                return $r;
            })),
            'a header that disagrees with the request' => array($change(function (array $r) {
                $r['agentmate-connector.php'] = (string) preg_replace('/Version:\s+1\.1\.0/', 'Version: 1.2.0', $r['agentmate-connector.php']);
                return $r;
            })),
            'a version constant that disagrees' => array($change(function (array $r) {
                $r['agentmate-connector.php'] = str_replace("'AGENTMATE_CONNECTOR_VERSION', '1.1.0'", "'AGENTMATE_CONNECTOR_VERSION', '1.2.0'", $r['agentmate-connector.php']);
                return $r;
            })),
            'a file over the size cap' => array($change(function (array $r) {
                $r['readme.txt'] = str_repeat('a', 2 * 1048576 + 1);
                return $r;
            })),
        );
    }

    /**
     * @dataProvider badPackages
     */
    public function testRefusesAPackageThatIsNotAConnector(callable $edit): void
    {
        $this->assertRefused('badPackage', $this->update($edit($this->release(self::NEW))));
    }

    public function testRefusesFilesThatDoNotMatchTheirHash(): void
    {
        $release = $this->release(self::NEW);
        $body = $this->body($release);
        $body['files'][1]['sha256'] = str_repeat('0', 64);
        $this->assertRefused('badPackage', $this->update($release, self::NEW, $body));

        $body = $this->body($release);
        $body['files'][1]['size'] += 1;
        $this->assertRefused('badPackage', $this->update($release, self::NEW, $body));

        $blobs = array_values($release);
        $blobs[1] .= ' ';
        $this->assertRefused('badPackage', $this->update($release, self::NEW, null, $blobs));
    }

    public function testRefusesMoreFilesThanAConnectorHas(): void
    {
        $release = $this->release(self::NEW);
        for ($index = 0; $index < 400; $index++) {
            $release['src/Extra/File' . $index . '.php'] = '<?php';
        }
        $this->assertError('badRequest', $this->update($release), 400);
        $this->assertSame(self::OLD, $this->versionOnDisk());
    }

    public function testReadsTheShapeOfTheRequestStrictly(): void
    {
        $release = $this->release(self::NEW);
        $good = $this->body($release);
        $cases = array(
            'no version' => array('files' => $good['files']),
            'a version that is not one' => array('version' => 'latest', 'files' => $good['files']),
            'no files' => array('version' => self::NEW),
            'an empty list' => array('version' => self::NEW, 'files' => array()),
            'an object for files' => array('version' => self::NEW, 'files' => array('a' => $good['files'][0])),
            'a file without a hash' => array('version' => self::NEW, 'files' => array(array('path' => 'x.php', 'size' => 1))),
            'a negative size' => array('version' => self::NEW, 'files' => array(array('path' => 'x.php', 'size' => -1, 'sha256' => str_repeat('a', 64)))),
        );
        foreach ($cases as $name => $body) {
            $this->assertError('badRequest', $this->update($release, self::NEW, $body), 400);
        }
        $this->assertError('badRequest', $this->update($release, self::NEW, null, array('one blob')), 400);
        $this->assertSame(self::OLD, $this->versionOnDisk(), 'Nothing changed.');
    }

    public function testWaitsForAnOpenDeploy(): void
    {
        $ops = array(self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2'));
        $begin = $this->assertOk($this->begin($ops));

        $result = $this->update($this->release(self::NEW));
        $this->assertError('busy', $result, 409);
        $this->assertSame($begin['deployId'], $result['body']['error']['details']['deployId']);
        $this->assertSame(self::OLD, $this->versionOnDisk());

        $this->assertOk($this->route('/deploy/abort', $begin['deployId']));
        $this->assertSame('updated', $this->assertOk($this->update($this->release(self::NEW)))['state']);
    }

    public function testWaitsForAnotherDeployCall(): void
    {
        $this->storage->kvAdd(DeployService::MUTEX, 'someone-else', $this->env->now + 60, $this->env->now);
        $result = $this->update($this->release(self::NEW));
        $this->assertError('busy', $result, 409);
        $this->assertSame(5, $result['body']['error']['details']['retryAfter']);
        $this->assertSame(self::OLD, $this->versionOnDisk());
    }

    public function testNoDeployStartsWhileTheMutexIsHeldAndItIsFreeAfterwards(): void
    {
        $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertNull($this->storage->kvGet(DeployService::MUTEX, $this->env->now));
        $ops = array(self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2'));
        $this->assertNotNull($this->assertOk($this->begin($ops))['deployId']);
    }

    public function testStopsWhenTheFolderCannotBeMovedAside(): void
    {
        $this->rename = function (string $from, string $to): bool {
            return false;
        };
        $this->assertRefused('notReplaceable', $this->update($this->release(self::NEW)));
    }

    public function testKeepsTheOldFolderWhenTheNewOneCannotTakeItsPlace(): void
    {
        $calls = 0;
        $this->rename = function (string $from, string $to) use (&$calls): bool {
            $calls++;
            // 1: plugin -> old (works), 2: new -> plugin (fails), 3: old -> plugin (works).
            return $calls === 2 ? false : rename($from, $to);
        };
        $this->assertRefused('notReplaceable', $this->update($this->release(self::NEW)));
        $this->assertSame(3, $calls);
    }

    public function testLeavesBothFoldersForTheOwnerWhenNothingCanBePutBack(): void
    {
        $calls = 0;
        $this->rename = function (string $from, string $to) use (&$calls): bool {
            $calls++;
            return $calls === 1 ? rename($from, $to) : false;
        };
        $result = $this->update($this->release(self::NEW));
        $this->assertError('internal', $result);
        $this->assertStringContainsString('.agentmate-connector-old-', $result['body']['error']['message']);
        $this->assertCount(2, $this->siblings(), 'The old and the new files are both kept.');
    }

    public function testPutsTheOldFilesBackWhenTheUndoFails(): void
    {
        $this->env->health = array($this->health(true), $this->health(false));
        $calls = 0;
        $this->rename = function (string $from, string $to) use (&$calls): bool {
            $calls++;
            // 1 and 2 do the swap; 3 (plugin -> failed) works; 4 (old -> plugin) fails; 5 puts failed back.
            return $calls === 4 ? false : rename($from, $to);
        };
        $result = $this->update($this->release(self::NEW));
        $this->assertError('internal', $result);
        $this->assertSame(self::NEW, $this->versionOnDisk(), 'The site is left running something, not nothing.');
    }

    public function testSweepsFoldersACrashedUpdateLeftBehind(): void
    {
        $this->env->put('plugins/.agentmate-connector-new-0123456789ab/src/Plugin.php', '<?php');
        $this->env->put('plugins/.agentmate-connector-old-0123456789ab/agentmate-connector.php', '<?php');
        $this->env->put('plugins/.agentmate-connector-notmine/keep.txt', 'keep');
        $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertSame(array('.agentmate-connector-notmine'), $this->siblings());
        $this->assertSame('keep', $this->read('plugins/.agentmate-connector-notmine/keep.txt'));
    }

    public function testDotFoldersAreNotPluginsToWordPress(): void
    {
        // get_plugins() skips entries that start with a dot; the staging folder relies on it.
        $this->assertSame('.', substr('.agentmate-connector-new-0123456789ab', 0, 1));
    }

    public function testRefusesASymlinkedPluginFolder(): void
    {
        if (!function_exists('symlink')) {
            $this->markTestSkipped('No symlinks here.');
        }
        $real = $this->tempDir() . '/real-connector';
        rename($this->path('plugins/agentmate-connector'), $real);
        if (!@symlink($real, $this->path('plugins/agentmate-connector'))) {
            $this->markTestSkipped('Symlinks are not allowed here.');
        }
        $result = $this->update($this->release(self::NEW));
        $this->assertError('updateRefused', $result, 422);
        $this->assertSame('notReplaceable', $result['body']['error']['details']['reason']);
        $this->assertSame(array(), $this->siblings());
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertFalse($info['selfUpdate']);
    }

    public function testSiteInfoSaysWhetherTheConnectorCanReplaceItself(): void
    {
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertTrue($info['selfUpdate']);

        $this->wipe($this->path('plugins/agentmate-connector'));
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertFalse($info['selfUpdate']);
    }

    public function testHelloAdvertisesTheUpdate(): void
    {
        $hello = $this->assertOk($this->call('/hello', null, array('unsigned' => true)));
        $this->assertContains('update', $hello['capabilities']);
    }

    // The site downloads the release ---------------------------------------------------------

    private function releaseUrl(string $version = self::NEW): string
    {
        return 'https://github.com/SmartClouds/AgentMate/releases/download/v' . $version . '/agentmate-connector.zip';
    }

    /**
     * An update the site downloads: the file list of $files, the release address, and no blobs.
     *
     * @param array<string, string> $files
     * @return array<string, mixed> the call result
     */
    private function downloadUpdate(array $files, ?string $url = null): array
    {
        $body = $this->body($files);
        $body['download'] = array('url' => $url !== null ? $url : $this->releaseUrl());
        return $this->update($files, self::NEW, $body, array());
    }

    public function testTheSiteDownloadsTheReleaseItself(): void
    {
        $release = $this->release(self::NEW);
        $this->env->downloads[$this->releaseUrl()] = ZipFixture::build($release);

        $data = $this->assertOk($this->downloadUpdate($release));

        $this->assertSame('updated', $data['state']);
        $this->assertSame(count($release), $data['files']);
        foreach ($release as $path => $bytes) {
            $this->assertSame($bytes, $this->installed($path), $path);
        }
        $this->assertSame("<?php\nreturn array('abspath' => '/site/');\n", $this->installed('rescue-config.php'));
        $this->assertSame(array(), $this->siblings());
        $this->assertCount(1, $this->env->downloadCalls);
        $this->assertSame($this->releaseUrl(), $this->env->downloadCalls[0]['url']);
        $entries = array_values(array_filter($this->storage->listAudit(50, null), function ($row) {
            return $row['event'] === 'connectorUpdated';
        }));
        $this->assertStringContainsString('downloaded by the site', $entries[0]['detail']);
    }

    public function testReadsAZipThatStoresItsFiles(): void
    {
        $release = $this->release(self::NEW);
        $this->env->downloads[$this->releaseUrl()] = ZipFixture::build($release, 'agentmate-connector/', 0);
        $this->assertSame('updated', $this->assertOk($this->downloadUpdate($release))['state']);
    }

    public function testADownloadThatFailsIsRefusedWithItsReason(): void
    {
        $result = $this->downloadUpdate($this->release(self::NEW));
        $this->assertRefused('downloadFailed', $result);
        $this->assertStringContainsString('Could not resolve host', $result['body']['error']['message']);
        $this->assertSame(0, $this->env->healthCalls, 'Nothing was tried on the site.');
    }

    /**
     * @return array<string, array{0: callable}>
     */
    public function notTheRelease(): array
    {
        return array(
            'a file that differs' => array(function (array $files) {
                $files['src/Plugin.php'] .= '// changed';
                return ZipFixture::build($files);
            }),
            'a file more' => array(function (array $files) {
                $files['src/Extra.php'] = '<?php';
                return ZipFixture::build($files);
            }),
            'a file less' => array(function (array $files) {
                unset($files['readme.txt']);
                return ZipFixture::build($files);
            }),
            'another top folder' => array(function (array $files) {
                return ZipFixture::build($files, 'something-else/');
            }),
            'an encrypted zip' => array(function (array $files) {
                return ZipFixture::build($files, 'agentmate-connector/', 8, 0x0801);
            }),
            'a cut-off zip' => array(function (array $files) {
                $zip = ZipFixture::build($files);
                return substr($zip, 0, (int) (strlen($zip) / 2));
            }),
            'an HTML page' => array(function () {
                return '<!doctype html><title>Not found</title>';
            }),
            'nothing' => array(function () {
                return '';
            }),
        );
    }

    /**
     * @dataProvider notTheRelease
     */
    public function testRefusesADownloadThatIsNotExactlyTheRelease(callable $zip): void
    {
        $release = $this->release(self::NEW);
        $this->env->downloads[$this->releaseUrl()] = $zip($release);
        $this->assertRefused('downloadFailed', $this->downloadUpdate($release));
    }

    public function testOnlyEverFetchesTheAgentMateReleaseOfTheVersionItInstalls(): void
    {
        $release = $this->release(self::NEW);
        $urls = array(
            'another version' => $this->releaseUrl('1.2.0'),
            'plain HTTP' => 'http://github.com/SmartClouds/AgentMate/releases/download/v1.1.0/agentmate-connector.zip',
            'another repository' => 'https://github.com/someone/AgentMate/releases/download/v1.1.0/agentmate-connector.zip',
            'another host' => 'https://example.test/AgentMate/releases/download/v1.1.0/agentmate-connector.zip',
            'another file' => 'https://github.com/SmartClouds/AgentMate/releases/download/v1.1.0/other.zip',
            'a query' => $this->releaseUrl() . '?x=1',
            'empty' => '',
        );
        foreach ($urls as $name => $url) {
            $this->assertError('badRequest', $this->downloadUpdate($release, $url), 400);
        }
        $body = $this->body($release);
        $body['download'] = 'yes';
        $this->assertError('badRequest', $this->update($release, self::NEW, $body, array()), 400);

        // A download carries no blobs.
        $body = $this->body($release);
        $body['download'] = array('url' => $this->releaseUrl());
        $this->assertError('badRequest', $this->update($release, self::NEW, $body), 400);

        $this->assertSame(array(), $this->env->downloadCalls);
        $this->assertSame(self::OLD, $this->versionOnDisk());
    }

    public function testChecksTheFileListBeforeDownloading(): void
    {
        $release = $this->release(self::NEW);
        unset($release['src/Plugin.php']);
        $this->assertRefused('badPackage', $this->downloadUpdate($release));
        $this->assertSame(array(), $this->env->downloadCalls);
    }

    public function testSiteInfoAndHelloSayTheSiteCanDownloadAnUpdate(): void
    {
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertTrue($info['updateDownload']);
        $hello = $this->assertOk($this->call('/hello', null, array('unsigned' => true)));
        $this->assertContains('updateDownload', $hello['capabilities']);
    }

    public function testNeverTouchesOtherPlugins(): void
    {
        $this->assertOk($this->update($this->release(self::NEW)));
        $this->assertSame('<?php // akismet', $this->read('plugins/akismet/akismet.php'));
        $this->assertSame('<?php // hello', $this->read('plugins/hello.php'));
    }
}
