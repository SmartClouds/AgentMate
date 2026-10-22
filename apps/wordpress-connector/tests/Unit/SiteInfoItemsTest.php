<?php
/**
 * /site/info, /items/list and the limits they report.
 *
 * @package AgentMate\Connector
 */

namespace AgentMate\Connector\Tests\Unit;

use AgentMate\Connector\Info\Limits;
use AgentMate\Connector\Tests\Support\TestCase;

final class SiteInfoItemsTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
    }

    public function testSiteInfoShape(): void
    {
        $connection = $this->connect('write', array('label' => 'Office', 'expires_at' => $this->env->now + 3600));
        $this->env->put('mu-plugins/00-agentmate-connector-guard.php', '<?php');
        $this->storage->kvSet('loopback', 'ok', null);
        $data = $this->assertOk($this->call('/site/info', null, array('connectionId' => $connection)));
        $this->assertSame(array(
            'siteName', 'homeUrl', 'siteUrl', 'wpVersion', 'phpVersion', 'pluginVersion', 'protocol', 'multisite',
            'activeTheme', 'https', 'serverTime', 'fileModsDisabled', 'fileEditDisabled', 'filesystemMethod',
            'readOnlyByConstant', 'selfUpdate', 'updateDownload', 'sodium', 'limits', 'guard', 'loopback', 'connection', 'pendingDeploy',
        ), array_keys($data));
        // The fake site has no connector folder to replace.
        $this->assertFalse($data['selfUpdate']);
        $this->assertSame(PHP_VERSION, $data['phpVersion']);
        $this->assertSame('1.0.0', $data['pluginVersion']);
        $this->assertSame(1, $data['protocol']);
        $this->assertSame(array('stylesheet' => 'twentytwentyfive', 'template' => 'twentytwentyfive'), $data['activeTheme']);
        $this->assertFalse($data['fileModsDisabled']);
        $this->assertSame('direct', $data['filesystemMethod']);
        $this->assertSame('native', $data['sodium']);
        $this->assertSame(array('installed' => true, 'rescueUrl' => null), $data['guard']);
        $this->assertSame('ok', $data['loopback']);
        $this->assertSame(array('id' => $connection, 'label' => 'Office', 'scope' => 'write', 'createdAt' => $this->env->now - 100, 'expiresAt' => $this->env->now + 3600), $data['connection']);
        $this->assertNull($data['pendingDeploy']);
        $this->assertSame(array(
            'maxRequestBytes' => 1677721,
            'maxResponseBytes' => 16777216,
            'maxFileBytes' => 67108864,
            'timeBudgetSeconds' => 15,
            'maxPathsPerRead' => 500,
            'manifestPageSize' => 2000,
            'maxFilesPerItem' => 20000,
        ), $data['limits']);
    }

    public function testLimitsFromIni(): void
    {
        $this->assertSame(134217728, Limits::iniBytes('128M'));
        $this->assertSame(1073741824, Limits::iniBytes('1G'));
        $this->assertSame(524288, Limits::iniBytes('512k'));
        $this->assertSame(1000, Limits::iniBytes('1000'));
        $this->assertSame(-1, Limits::iniBytes('-1'));
        $this->assertSame(0, Limits::iniBytes(''));

        $this->assertSame(1677721, Limits::maxRequestBytes('8M', '2M'));
        $this->assertSame(16777216, Limits::maxRequestBytes('64M', '64M'));
        $this->assertSame(16777216, Limits::maxRequestBytes('0', '-1'));
        $this->assertSame(838860, Limits::maxRequestBytes('1M', '0'));

        $this->assertSame(16777216, Limits::maxResponseBytes('-1', 0));
        $this->assertSame(4194304, Limits::maxResponseBytes('40M', 20 * 1048576));
        $this->assertSame(262144, Limits::maxResponseBytes('21M', 21 * 1048576));

        $this->assertSame(20, Limits::timeBudgetSeconds('0'));
        $this->assertSame(15, Limits::timeBudgetSeconds('30'));
        $this->assertSame(5, Limits::timeBudgetSeconds('5'));
        $this->assertSame(20, Limits::timeBudgetSeconds('300'));
    }

    public function testItemsList(): void
    {
        $env = $this->env;
        foreach (array('themes/twentytwentyfive/style.css', 'themes/child/style.css', 'themes/bad name/style.css', 'plugins/akismet/akismet.php', 'plugins/akismet/other.php', 'plugins/hello.php', 'plugins/agentmate-connector/agentmate-connector.php', 'mu-plugins/loader.php', 'mu-plugins/00-agentmate-connector-guard.php', 'mu-plugins/folder/inner.php') as $path) {
            $env->put($path, '<?php');
        }
        $env->themes = array(
            array('slug' => 'twentytwentyfive', 'name' => 'Twenty Twenty-Five', 'version' => '1.2', 'parent' => null),
            array('slug' => 'child', 'name' => 'Child', 'version' => '0.1', 'parent' => 'twentytwentyfive'),
            array('slug' => 'bad name', 'name' => 'Bad', 'version' => '1', 'parent' => null),
        );
        $env->activeTheme = array('stylesheet' => 'child', 'template' => 'twentytwentyfive');
        $env->plugins = array(
            'akismet/other.php' => array('Name' => 'Other', 'Version' => '1'),
            'akismet/akismet.php' => array('Name' => 'Akismet', 'Version' => '5.3'),
            'hello.php' => array('Name' => 'Hello Dolly', 'Version' => '1.7'),
            'agentmate-connector/agentmate-connector.php' => array('Name' => 'AgentMate Connector', 'Version' => '1.0.0'),
        );
        $env->activePlugins = array('akismet/akismet.php');
        $env->muPlugins = array(
            'loader.php' => array('Name' => 'Loader', 'Version' => ''),
            '00-agentmate-connector-guard.php' => array('Name' => 'Guard', 'Version' => ''),
        );

        $items = $this->assertOk($this->call('/items/list', null, array('connectionId' => $this->connect())))['items'];
        $byKey = array();
        foreach ($items as $item) {
            $byKey[$item['kind'] . ':' . $item['slug']] = $item;
        }
        $this->assertSame(array(
            'theme:child', 'theme:twentytwentyfive',
            'plugin:agentmate-connector', 'plugin:akismet', 'plugin:hello.php',
            'mu-plugin:00-agentmate-connector-guard.php', 'mu-plugin:folder', 'mu-plugin:loader.php',
        ), array_keys($byKey));

        $this->assertSame(array(
            'kind' => 'theme', 'slug' => 'child', 'name' => 'Child', 'version' => '0.1', 'isFile' => false,
            'active' => true, 'networkActive' => false, 'writable' => true, 'protected' => false, 'parentTheme' => 'twentytwentyfive',
        ), $byKey['theme:child']);
        $this->assertTrue($byKey['theme:twentytwentyfive']['active']);
        $this->assertSame('akismet/akismet.php', $byKey['plugin:akismet']['mainFile']);
        $this->assertSame('Akismet', $byKey['plugin:akismet']['name']);
        $this->assertTrue($byKey['plugin:akismet']['active']);
        $this->assertTrue($byKey['plugin:hello.php']['isFile']);
        $this->assertFalse($byKey['plugin:hello.php']['active']);
        $this->assertTrue($byKey['plugin:agentmate-connector']['protected']);
        $this->assertFalse($byKey['plugin:agentmate-connector']['writable']);
        $this->assertTrue($byKey['mu-plugin:00-agentmate-connector-guard.php']['protected']);
        $this->assertTrue($byKey['mu-plugin:loader.php']['active']);
        $this->assertTrue($byKey['mu-plugin:loader.php']['isFile']);
        $this->assertFalse($byKey['mu-plugin:folder']['isFile']);
        $this->assertSame('folder', $byKey['mu-plugin:folder']['name']);
    }

    public function testNothingIsWritableWhenWritesAreOff(): void
    {
        $this->env->put('themes/twentytwentyfive/style.css', 'x');
        $this->env->themes = array(array('slug' => 'twentytwentyfive', 'name' => 'T', 'version' => '1', 'parent' => null));
        $connection = $this->connect();
        foreach (array('readOnly', 'fileMods', 'method') as $switch) {
            if ($switch === 'readOnly') {
                $this->env->constants['AGENTMATE_CONNECTOR_READ_ONLY'] = true;
            } elseif ($switch === 'fileMods') {
                $this->env->fileModsAllowed = false;
            } else {
                $this->env->filesystemMethod = 'ftpext';
            }
            $items = $this->assertOk($this->call('/items/list', null, array('connectionId' => $connection)))['items'];
            $this->assertFalse($items[0]['writable'], $switch);
            $this->env->constants = array();
            $this->env->fileModsAllowed = true;
            $this->env->filesystemMethod = 'direct';
        }
    }

    public function testPendingDeployIsReported(): void
    {
        $this->storage->kvSet('pendingDeploy', json_encode(array('deployId' => 'd1', 'state' => 'applied', 'deadline' => 1790000180)), null);
        $data = $this->assertOk($this->call('/site/info', null, array('connectionId' => $this->connect())));
        $this->assertSame(array('deployId' => 'd1', 'state' => 'applied', 'deadline' => 1790000180), $data['pendingDeploy']);
    }
}
