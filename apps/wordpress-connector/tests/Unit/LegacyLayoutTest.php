<?php
/**
 * Sites that ran AgentMate Connector 1.63: the bridge layout (the Runova code in the old folder),
 * /connector/migrate moving it to runova-connector/, and the old names the plugin still answers
 * to (signing prefix, wp-config.php switches, class names the 1.63 guard calls).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Guard\GuardInstaller;
use Runova\Connector\Protocol;
use Runova\Connector\Support\Constants;
use Runova\Connector\Tests\Support\DeployTestCase;
use Runova\Connector\Tests\Support\FakeLayoutHost;
use Runova\Connector\Tests\Support\ZipFixture;
use Runova\Connector\Update\LayoutMigration;

final class LegacyLayoutTest extends DeployTestCase
{
    const VERSION = '1.64.0';
    const LEGACY_GUARD = "<?php\n/**\n * Plugin Name: AgentMate Connector Guard\n */\n\$agentmate_connector_dir = '/old';\n";

    /** @var FakeLayoutHost */
    private $host;

    protected function setUp(): void
    {
        parent::setUp();
        $this->host = new FakeLayoutHost();
        $this->layoutHost = $this->host;
        $this->bridge();
    }

    protected function tearDown(): void
    {
        Constants::useLookup(null);
        parent::tearDown();
    }

    /** A site the 1.63 updater has just moved onto the bridge package. */
    private function bridge(): void
    {
        $this->remove($this->path('plugins/runova-connector'));
        $env = $this->env;
        $env->layout = 'bridge';
        $env->connectorSlug = 'agentmate-connector';
        $env->pluginVersion = self::VERSION;
        foreach ($this->bridgeFiles(self::VERSION) as $path => $bytes) {
            $env->put('plugins/agentmate-connector/' . $path, $bytes);
        }
        $env->put('plugins/agentmate-connector/rescue-config.php', "<?php\nreturn array('abspath' => '/site/');\n");
        $env->put('mu-plugins/00-agentmate-connector-guard.php', self::LEGACY_GUARD);
        $this->host->active = array('agentmate-connector/agentmate-connector.php', 'akismet/akismet.php');
    }

    /** @return array<string, string> */
    private function bridgeFiles(string $version): array
    {
        return array(
            'agentmate-connector.php' => "<?php\n/**\n * Plugin Name:       AgentMate Connector\n * Version:           {$version}\n * Requires PHP:      7.4\n */\ndefine('AGENTMATE_CONNECTOR_VERSION', '{$version}');\n",
            'layout/runova-connector.php' => $this->runovaMain($version),
            'src/Autoloader.php' => "<?php // autoloader {$version}\n",
            'src/Plugin.php' => "<?php // plugin {$version}\n",
            'guard/00-runova-connector-guard.php' => "<?php\n/**\n * Plugin Name: Runova Connector Guard\n */\n\$runova_connector_dir = '';\n",
            'guard/00-agentmate-connector-guard.php' => "<?php // retired\n",
            'rescue.php' => "<?php // rescue\n",
        );
    }

    private function runovaMain(string $version): string
    {
        return "<?php\n/**\n * Plugin Name:       Runova Connector\n * Version:           {$version}\n * Requires PHP:      7.4\n */\ndefine('RUNOVA_CONNECTOR_VERSION', '{$version}');\n";
    }

    private function remove(string $path): void
    {
        if (is_file($path)) {
            unlink($path);
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        foreach ((array) scandir($path) as $name) {
            if ($name !== '.' && $name !== '..') {
                $this->remove($path . '/' . $name);
            }
        }
        rmdir($path);
    }

    /** @return array<string, mixed> */
    private function migrate(?string $connection = null): array
    {
        return $this->call('/connector/migrate', null, array('connectionId' => $connection === null ? $this->write : $connection));
    }

    // The move ---------------------------------------------------------------------------------

    public function testMovesABridgeSiteToItsOwnFolder(): void
    {
        $data = $this->assertOk($this->migrate());

        $this->assertSame('migrated', $data['state']);
        $this->assertSame('runova', $data['layout']);
        $this->assertSame(self::VERSION, $data['version']);
        $this->assertSame('https://example.test/wp-json/runova/v1', $data['restUrl']);
        $this->assertSame('https://example.test/wp-content/plugins/runova-connector/rescue.php', $data['rescueUrl']);

        $this->assertSame($this->runovaMain(self::VERSION), $this->read('plugins/runova-connector/runova-connector.php'));
        $this->assertSame('<?php // plugin ' . self::VERSION . "\n", $this->read('plugins/runova-connector/src/Plugin.php'));
        $this->assertSame("<?php\nreturn array('abspath' => '/site/');\n", $this->read('plugins/runova-connector/rescue-config.php'));
        $this->assertNull($this->read('plugins/runova-connector/agentmate-connector.php'));
        $this->assertNull($this->read('plugins/runova-connector/guard/00-agentmate-connector-guard.php'));
        $this->assertDirectoryDoesNotExist($this->path('plugins/runova-connector/layout'));

        $guard = (string) $this->read('mu-plugins/00-runova-connector-guard.php');
        $this->assertStringContainsString(var_export($this->path('plugins/runova-connector'), true), $guard);
        $this->assertNull($this->read('mu-plugins/00-agentmate-connector-guard.php'));

        $this->assertSame(array('runova-connector/runova-connector.php', 'akismet/akismet.php'), $this->host->active);
        // The old folder stays for its grace period; the job removes it later.
        $this->assertDirectoryExists($this->path('plugins/agentmate-connector'));
        $this->assertSame(array('dir' => $this->path('plugins/agentmate-connector'), 'at' => $this->env->now + LayoutMigration::GRACE_SECONDS), $this->host->job);
        $this->assertSame(array(), $this->dotFolders());
        $events = array_column($this->storage->listAudit(10, null), 'detail');
        $this->assertStringContainsString('to its own folder', $events[0]);
    }

    public function testMovesANetworkActivatedConnector(): void
    {
        $this->host->active = array();
        $this->host->sitewide = array('agentmate-connector/agentmate-connector.php' => 1700000000);
        $this->assertSame('migrated', $this->assertOk($this->migrate())['state']);
        $this->assertSame(array('runova-connector/runova-connector.php' => 1700000000), $this->host->sitewide);
    }

    public function testPutsEverythingBackWhenTheSiteFailsItsHealthCheck(): void
    {
        $this->env->health = array($this->health(true), $this->health(false));

        $data = $this->assertOk($this->migrate());

        $this->assertSame('rolledBack', $data['state']);
        $this->assertSame('bridge', $data['layout']);
        $this->assertDirectoryDoesNotExist($this->path('plugins/runova-connector'));
        $this->assertSame(self::LEGACY_GUARD, $this->read('mu-plugins/00-agentmate-connector-guard.php'));
        $this->assertNull($this->read('mu-plugins/00-runova-connector-guard.php'));
        $this->assertSame(array('agentmate-connector/agentmate-connector.php', 'akismet/akismet.php'), $this->host->active);
        $this->assertNull($this->host->job);
        $this->assertSame(array(), $this->dotFolders());
    }

    public function testPutsEverythingBackWhenThePluginListCannotBeWritten(): void
    {
        $this->host->onSwap = function () {
            throw new \RuntimeException('The options table is read-only.');
        };
        $this->assertError('internal', $this->migrate());
        $this->assertDirectoryDoesNotExist($this->path('plugins/runova-connector'));
        $this->assertSame(self::LEGACY_GUARD, $this->read('mu-plugins/00-agentmate-connector-guard.php'));
    }

    public function testRefusesWhenTheNewFolderCannotBePutInPlace(): void
    {
        $this->rename = function (): bool {
            return false;
        };
        $result = $this->migrate();
        $this->assertError('updateRefused', $result, 422);
        $this->assertSame('notReplaceable', $result['body']['error']['details']['reason']);
        $this->assertDirectoryDoesNotExist($this->path('plugins/runova-connector'));
        $this->assertSame(array(), $this->dotFolders());
        $this->assertSame(self::LEGACY_GUARD, $this->read('mu-plugins/00-agentmate-connector-guard.php'));
        $this->assertSame(0, $this->host->swaps);
    }

    public function testLeavesSomeoneElsesFolderAlone(): void
    {
        $this->env->put('plugins/runova-connector/readme.txt', 'mine');
        $result = $this->migrate();
        $this->assertError('updateRefused', $result);
        $this->assertSame('mine', $this->read('plugins/runova-connector/readme.txt'));
    }

    public function testReplacesWhatACrashedMoveLeftBehind(): void
    {
        $this->env->put('plugins/runova-connector/runova-connector.php', $this->runovaMain(self::VERSION));
        $this->env->put('plugins/.runova-connector-new-0123456789ab/src/Plugin.php', '<?php');
        $this->assertSame('migrated', $this->assertOk($this->migrate())['state']);
        $this->assertSame(array(), $this->dotFolders());
    }

    public function testAMovedSiteAnswersCurrent(): void
    {
        $this->env->layout = 'runova';
        $this->env->connectorSlug = 'runova-connector';
        $data = $this->assertOk($this->migrate());
        $this->assertSame('current', $data['state']);
        $this->assertSame(0, $this->host->swaps);
    }

    public function testNeedsAWriteKeyAndNoReadOnlySwitch(): void
    {
        $this->assertError('readOnly', $this->migrate($this->connect('read')));
        $this->env->constants['RUNOVA_CONNECTOR_READ_ONLY'] = true;
        $this->assertError('readOnly', $this->migrate());
        $this->assertDirectoryDoesNotExist($this->path('plugins/runova-connector'));
    }

    public function testHelloAndSiteInfoReportTheLayout(): void
    {
        $hello = $this->assertOk($this->call('/hello', null, array('unsigned' => true)));
        $this->assertContains('migrate', $hello['capabilities']);
        $this->assertSame('bridge', $hello['layout']);
        $this->assertSame(array('restUrl' => 'https://example.test/wp-json/runova/v1', 'ajaxUrl' => 'https://example.test/wp-admin/admin-ajax.php'), $hello['endpoints']);
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write)));
        $this->assertSame('bridge', $info['layout']);
    }

    // Removing the old folder -----------------------------------------------------------------

    public function testTheOldFolderGoesOnlyAfterItsGracePeriod(): void
    {
        $this->assertOk($this->migrate());
        $old = $this->path('plugins/agentmate-connector');

        LayoutMigration::cleanUp($this->host, $this->env->now + LayoutMigration::GRACE_SECONDS - 1);
        $this->assertDirectoryExists($old);
        $this->assertNotNull($this->host->job);

        LayoutMigration::cleanUp($this->host, $this->env->now + LayoutMigration::GRACE_SECONDS);
        $this->assertDirectoryDoesNotExist($old);
        $this->assertNull($this->host->job);
        $this->assertDirectoryExists($this->path('plugins/runova-connector'));
    }

    public function testTheOldFolderStaysWhenItIsInUseAgain(): void
    {
        $this->assertOk($this->migrate());
        $this->host->active = array('agentmate-connector/agentmate-connector.php');
        LayoutMigration::cleanUp($this->host, $this->env->now + 3600);
        $this->assertDirectoryExists($this->path('plugins/agentmate-connector'));
        $this->assertNull($this->host->job);
    }

    public function testCleanUpOnlyEverDeletesTheOldConnectorFolder(): void
    {
        $this->env->put('plugins/akismet/akismet.php', '<?php');
        $this->host->active = array('runova-connector/runova-connector.php');
        $this->host->job = array('dir' => $this->path('plugins/akismet'), 'at' => 0);
        LayoutMigration::cleanUp($this->host, $this->env->now);
        $this->assertDirectoryExists($this->path('plugins/akismet'));
    }

    public function testTheGracePeriodCanBeShortenedForTests(): void
    {
        $this->assertSame(LayoutMigration::GRACE_SECONDS, LayoutMigration::grace());
        Constants::useLookup(function (string $name) {
            return $name === 'RUNOVA_CONNECTOR_MIGRATION_GRACE_SECONDS' ? '2' : null;
        });
        $this->assertSame(2, LayoutMigration::grace());
    }

    // Updates in the bridge layout -------------------------------------------------------------

    /**
     * @param array<string, string> $files
     * @return array<string, mixed>
     */
    private function update(array $files, string $version, ?string $url = null): array
    {
        $entries = array();
        foreach ($files as $path => $bytes) {
            $entries[] = array('path' => $path, 'size' => strlen($bytes), 'sha256' => hash('sha256', $bytes));
        }
        $body = array('version' => $version, 'files' => $entries);
        if ($url !== null) {
            $body['download'] = array('url' => $url);
        }
        return $this->call('/connector/update', $body, array('connectionId' => $this->write, 'blobs' => $url !== null ? array() : array_values($files)));
    }

    public function testABridgeSiteTakesTheBridgePackageAgain(): void
    {
        $files = $this->bridgeFiles('1.65.0');
        $data = $this->assertOk($this->update($files, '1.65.0'));
        $this->assertSame('updated', $data['state']);
        $this->assertSame($files['layout/runova-connector.php'], $this->read('plugins/agentmate-connector/layout/runova-connector.php'));
    }

    public function testABridgeSiteRefusesTheRunovaPackage(): void
    {
        $files = array(
            'runova-connector.php' => $this->runovaMain('1.65.0'),
            'src/Autoloader.php' => '<?php',
            'src/Plugin.php' => '<?php',
            'guard/00-runova-connector-guard.php' => '<?php',
        );
        $result = $this->update($files, '1.65.0');
        $this->assertError('updateRefused', $result);
        $this->assertSame('badPackage', $result['body']['error']['details']['reason']);
    }

    public function testABridgePackageNeedsItsRunovaMainFileForTheSameRelease(): void
    {
        $files = $this->bridgeFiles('1.65.0');
        $files['layout/runova-connector.php'] = $this->runovaMain('1.64.9');
        $this->assertError('updateRefused', $this->update($files, '1.65.0'));
    }

    public function testABridgeSiteDownloadsTheBridgeZipUnderEitherRepositoryName(): void
    {
        $files = $this->bridgeFiles('1.65.0');
        foreach (array('AgentMate', 'Runova') as $repo) {
            $url = 'https://github.com/SmartClouds/' . $repo . '/releases/download/v1.65.0/agentmate-connector.zip';
            $this->env->downloads[$url] = ZipFixture::build($files, 'agentmate-connector/');
            $this->assertSame('updated', $this->assertOk($this->update($files, '1.65.0', $url))['state'], $repo);
        }
        $runovaZip = 'https://github.com/SmartClouds/Runova/releases/download/v1.65.0/runova-connector.zip';
        $this->assertError('badRequest', $this->update($files, '1.65.0', $runovaZip));
    }

    public function testTheDownloadAddressTakesBothRepositoriesAndBothZips(): void
    {
        $this->assertSame(array('tag' => '1.2.3', 'folder' => 'runova-connector'), Protocol::downloadTag('https://github.com/SmartClouds/Runova/releases/download/v1.2.3/runova-connector.zip'));
        $this->assertSame(array('tag' => '1.2.3', 'folder' => 'runova-connector'), Protocol::downloadTag('https://github.com/SmartClouds/AgentMate/releases/download/v1.2.3/runova-connector.zip'));
        $this->assertSame(array('tag' => '1.2.3', 'folder' => 'agentmate-connector'), Protocol::downloadTag('https://github.com/SmartClouds/AgentMate/releases/download/v1.2.3/agentmate-connector.zip'));
        $this->assertNull(Protocol::downloadTag('https://github.com/Someone/Runova/releases/download/v1.2.3/runova-connector.zip'));
        $this->assertNull(Protocol::downloadTag('https://github.com/SmartClouds/Runova/releases/download/v1.2.3/other.zip'));
    }

    // Old names ---------------------------------------------------------------------------------

    public function testARequestSignedTheOldWayIsAnsweredTheOldWay(): void
    {
        $old = Protocol::LEGACY_PREFIX;
        $info = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write, 'prefix' => $old)));
        $this->assertSame('bridge', $info['layout']);
        // Whatever address it came in at: a 1.63 desktop may use the new ones the site reported.
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write, 'prefix' => $old, 'hint' => Protocol::PREFIX)));
        // A reply is signed the way the request verified, not the way its address suggests.
        $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->write, 'hint' => $old, 'replyPrefix' => Protocol::PREFIX)));
        // An unsigned call is answered the way its address suggests.
        $this->assertOk($this->call('/hello', null, array('unsigned' => true, 'hint' => $old)));
    }

    public function testASignatureUnderNeitherPrefixIsRefused(): void
    {
        $this->assertError('badSignature', $this->call('/site/info', null, array('connectionId' => $this->write, 'secretKey' => Crypto::keypairFromSeed(str_repeat('k', 32))['secret'])));
    }

    public function testTheOldWpConfigSwitchesStillWork(): void
    {
        $defined = array('AGENTMATE_CONNECTOR_READ_ONLY' => true, 'AGENTMATE_CONNECTOR_DATA_DIR' => '/data/old', 'RUNOVA_CONNECTOR_CONFIRM_SECONDS' => '30', 'AGENTMATE_CONNECTOR_CONFIRM_SECONDS' => '60');
        Constants::useLookup(function (string $name) use ($defined) {
            return isset($defined[$name]) ? $defined[$name] : null;
        });
        $this->assertTrue(Constants::on('RUNOVA_CONNECTOR_READ_ONLY'));
        $this->assertFalse(Constants::on('RUNOVA_CONNECTOR_DISABLED'));
        $this->assertSame('/data/old', Constants::value('RUNOVA_CONNECTOR_DATA_DIR'));
        $this->assertSame('30', Constants::value('RUNOVA_CONNECTOR_CONFIRM_SECONDS'), 'The new name wins.');
        $this->assertNull(Constants::value('DISALLOW_FILE_EDIT'));
    }

    public function testTheOldGuardFindsTheClassesByTheirOldNames(): void
    {
        $this->assertTrue(class_exists('AgentMate\\Connector\\Autoloader'));
        $this->assertTrue(class_exists('AgentMate\\Connector\\Guard\\GuardRuntime'));
        $this->assertSame(Protocol::VERSION, \AgentMate\Connector\Protocol::VERSION);
        $this->assertFalse(class_exists('AgentMate\\Connector\\NoSuchClass'));
    }

    public function testTheGuardReplacesTheOldOneButNotSomeoneElsesFile(): void
    {
        $mu = $this->path('mu-plugins');
        $this->assertTrue(GuardInstaller::installAt($mu, $this->path('plugins/agentmate-connector')));
        $this->assertNull($this->read('mu-plugins/00-agentmate-connector-guard.php'));
        $this->assertNotNull($this->read('mu-plugins/00-runova-connector-guard.php'));

        $this->env->put('mu-plugins/00-agentmate-connector-guard.php', '<?php // not ours');
        $this->assertTrue(GuardInstaller::installAt($mu, $this->path('plugins/agentmate-connector')));
        $this->assertSame('<?php // not ours', $this->read('mu-plugins/00-agentmate-connector-guard.php'));
    }

    /** @return string[] */
    private function dotFolders(): array
    {
        return array_values(array_filter((array) scandir($this->path('plugins')), function ($name) {
            return is_string($name) && strncmp($name, '.runova-connector-', 18) === 0;
        }));
    }

    /**
     * @return array<int, array{name: string, status: int|null, ok: bool|null, detail: string}>
     */
    private function health(bool $ok): array
    {
        return array(
            array('name' => 'home', 'status' => 200, 'ok' => true, 'detail' => 'HTTP 200'),
            array('name' => 'ajaxPing', 'status' => $ok ? 200 : 500, 'ok' => $ok, 'detail' => 'HTTP ' . ($ok ? 200 : 500)),
        );
    }
}
