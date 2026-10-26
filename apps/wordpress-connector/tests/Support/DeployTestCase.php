<?php
/**
 * Helpers for deploy tests: a small site, and begin/upload/commit as the desktop sends them.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

abstract class DeployTestCase extends TestCase
{
    /** @var string a write connection */
    protected $write;

    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
        $this->write = $this->connect('write');
        $env = $this->env;
        $env->put('themes/twentytwentyfive/style.css', '/* Theme Name: TT5 */');
        $env->put('themes/twentytwentyfive/index.php', '<?php // index');
        $env->put('themes/twentytwentyfive/functions.php', '<?php // v1');
        $env->put('themes/twentytwentyfive/readme.txt', 'readme');
        $env->put('themes/child/style.css', '/* child */');
        $env->put('plugins/akismet/akismet.php', '<?php // akismet');
        $env->put('plugins/hello.php', '<?php // hello');
        $env->put('plugins/runova-connector/runova-connector.php', '<?php // us');
        $env->activePlugins = array('akismet/akismet.php');
    }

    protected function path(string $relative): string
    {
        return $this->env->content . '/' . $relative;
    }

    protected function read(string $relative): ?string
    {
        $path = $this->path($relative);
        return is_file($path) ? (string) file_get_contents($path) : null;
    }

    /** sha256 of a file on the fake site, or null. */
    protected function sha(string $relative): ?string
    {
        $path = $this->path($relative);
        return is_file($path) ? hash_file('sha256', $path) : null;
    }

    /**
     * A put op; expected defaults to what is on the site now.
     *
     * @param mixed $expected
     * @return array<string, mixed>
     */
    protected static function put(string $kind, string $slug, string $path, string $content, $expected = 'current'): array
    {
        return array('op' => 'put', 'item' => array('kind' => $kind, 'slug' => $slug), 'path' => $path, 'sha256' => hash('sha256', $content), 'size' => strlen($content), 'expected' => $expected, '_content' => $content);
    }

    /**
     * @param mixed $expected
     * @return array<string, mixed>
     */
    protected static function delete(string $kind, string $slug, string $path, $expected = 'current'): array
    {
        return array('op' => 'delete', 'item' => array('kind' => $kind, 'slug' => $slug), 'path' => $path, 'expected' => $expected);
    }

    /**
     * Fills in expected = current hash, and strips test-only keys.
     *
     * @param array<int, array<string, mixed>> $ops
     * @return array<int, array<string, mixed>>
     */
    protected function wire(array $ops): array
    {
        $out = array();
        foreach ($ops as $op) {
            if ($op['expected'] === 'current') {
                $root = $op['item']['kind'] === 'theme' ? 'themes' : ($op['item']['kind'] === 'plugin' ? 'plugins' : 'mu-plugins');
                $relative = PathJoin::item($root, $op['item']['slug'], $op['path']);
                $op['expected'] = $this->sha($relative);
            }
            unset($op['_content']);
            $out[] = $op;
        }
        return $out;
    }

    /**
     * @param array<int, array<string, mixed>> $ops
     * @return array<string, mixed> the call result
     */
    protected function begin(array $ops, array $items = array(), bool $force = false, ?string $connection = null): array
    {
        if (count($items) === 0) {
            foreach ($ops as $op) {
                $items[$op['item']['kind'] . ':' . $op['item']['slug']] = $op['item'];
            }
            $items = array_values($items);
        }
        $body = array('label' => 'Test deploy', 'items' => $items, 'ops' => $this->wire($ops));
        if ($force) {
            $body['force'] = true;
        }
        return $this->call('/deploy/begin', $body, array('connectionId' => $connection === null ? $this->write : $connection));
    }

    /**
     * Uploads every put in one call, each as a single final chunk.
     *
     * @param array<int, array<string, mixed>> $ops
     */
    protected function upload(string $deployId, array $ops): array
    {
        $chunks = array();
        $blobs = array();
        foreach ($ops as $index => $op) {
            if ($op['op'] === 'put') {
                $chunks[] = array('op' => $index, 'offset' => 0, 'final' => true);
                $blobs[] = $op['_content'];
            }
        }
        return $this->call('/deploy/upload', array('deployId' => $deployId, 'chunks' => $chunks), array('connectionId' => $this->write, 'blobs' => $blobs));
    }

    protected function route(string $route, string $deployId, array $extra = array()): array
    {
        return $this->call($route, array('deployId' => $deployId) + $extra, array('connectionId' => $this->write));
    }

    /**
     * begin + upload + commit; returns the deploy id.
     *
     * @param array<int, array<string, mixed>> $ops
     */
    protected function apply(array $ops, bool $force = false): string
    {
        $begin = $this->assertOk($this->begin($ops, array(), $force));
        $this->assertNotNull($begin['deployId'], json_encode($begin));
        $this->assertOk($this->upload($begin['deployId'], $ops));
        $commit = $this->assertOk($this->route('/deploy/commit', $begin['deployId']));
        $this->assertSame('applied', $commit['state'], json_encode($commit));
        return $begin['deployId'];
    }

    protected function stateOf(string $deployId): string
    {
        return $this->storage->getDeploy($deployId)['state'];
    }

    /** @return array<string, mixed> the deploy's decoded data */
    protected function dataOf(string $deployId): array
    {
        return json_decode($this->storage->getDeploy($deployId)['data'], true);
    }

    /** @return array<int, array<string, mixed>> a typical change set on the active theme */
    protected function themeChange(): array
    {
        return array(
            self::put('theme', 'twentytwentyfive', 'functions.php', '<?php // v2'),
            self::put('theme', 'twentytwentyfive', 'inc/new/helper.php', '<?php // new', null),
            self::delete('theme', 'twentytwentyfive', 'readme.txt'),
        );
    }
}
