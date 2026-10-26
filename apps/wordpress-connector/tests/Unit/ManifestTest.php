<?php
/**
 * /items/manifest: order, paging with a cursor, skip reasons, the hash cache and item checks.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Files\ItemResolver;
use Runova\Connector\Files\Manifest;
use Runova\Connector\Files\Paths;
use Runova\Connector\Tests\Support\TestCase;

final class ManifestTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
    }

    private function theme(): array
    {
        $files = array(
            'style.css' => 'body{}',
            'functions.php' => '<?php',
            'a.txt' => 'a',
            'a/x.php' => 'x',
            'a-b/y.php' => 'y',
            'inc/deep/z.php' => 'z',
            'inc/setup.php' => 's',
            'empty.txt' => '',
        );
        foreach ($files as $path => $content) {
            $this->env->put('themes/demo/' . $path, $content);
        }
        return $files;
    }

    /**
     * @return array{entries: array<int, array<string, mixed>>, skipped: array<int, array<string, string>>, pages: int}
     */
    private function all(Manifest $manifest, array $item): array
    {
        $entries = array();
        $skipped = array();
        $cursor = null;
        $pages = 0;
        do {
            $page = $manifest->page($item, $cursor, 10.0);
            $entries = array_merge($entries, $page['entries']);
            $skipped = array_merge($skipped, $page['skipped']);
            $cursor = $page['cursor'];
            $pages++;
            $this->assertLessThan(100, $pages);
        } while ($cursor !== null);
        return array('entries' => $entries, 'skipped' => $skipped, 'pages' => $pages);
    }

    public function testListsEveryFileInWalkOrderWithHashes(): void
    {
        $files = $this->theme();
        $data = $this->assertOk($this->call('/items/manifest', array('item' => array('kind' => 'theme', 'slug' => 'demo')), array('connectionId' => $this->connect())));
        $this->assertFalse($data['isFile']);
        $this->assertNull($data['cursor']);
        $this->assertSame(array(), $data['skipped']);
        $paths = array_column($data['entries'], 'path');
        $this->assertSame(array('a/x.php', 'a-b/y.php', 'a.txt', 'empty.txt', 'functions.php', 'inc/deep/z.php', 'inc/setup.php', 'style.css'), $paths);
        foreach ($data['entries'] as $entry) {
            $this->assertSame(strlen($files[$entry['path']]), $entry['size']);
            $this->assertSame(hash('sha256', $files[$entry['path']]), $entry['sha256']);
        }
    }

    public function testPagingCoversEverythingOnce(): void
    {
        $files = $this->theme();
        $item = (new ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        for ($size = 1; $size <= 4; $size++) {
            $result = $this->all(new Manifest($this->storage, $this->env, $size), $item);
            $paths = array_column($result['entries'], 'path');
            $this->assertCount(count($files), $paths, 'page size ' . $size);
            $this->assertSame(count($paths), count(array_unique($paths)));
            $sorted = $paths;
            usort($sorted, array(Paths::class, 'compare'));
            $this->assertSame($sorted, $paths);
        }
    }

    public function testTimeBudgetStopsAPageAndTheCursorResumes(): void
    {
        $this->theme();
        $item = (new ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        $this->env->elapsedStep = 1.0;
        $manifest = new Manifest($this->storage, $this->env, 2000);
        $first = $manifest->page($item, null, 2.5);
        $this->assertNotNull($first['cursor']);
        $this->assertLessThan(8, count($first['entries']));
        $this->assertGreaterThan(0, count($first['entries']));
        $this->env->elapsed = 0.0;
        $this->env->elapsedStep = 0.0;
        $paths = array_column($first['entries'], 'path');
        $cursor = $first['cursor'];
        while ($cursor !== null) {
            $page = $manifest->page($item, $cursor, 10.0);
            $paths = array_merge($paths, array_column($page['entries'], 'path'));
            $cursor = $page['cursor'];
        }
        $this->assertCount(8, $paths);
        $this->assertCount(8, array_unique($paths));
    }

    public function testSkipsWithReasons(): void
    {
        $this->theme();
        $root = $this->env->content . '/themes/demo';
        $this->env->put('themes/demo/.git/HEAD', 'ref');
        $this->env->put('themes/demo/CLAUDE.md', 'x');
        $this->env->put('themes/demo/big.bin', str_repeat('b', 2048));
        symlink('/etc', $root . '/etc-link');
        symlink($root . '/style.css', $root . '/style-link.css');
        file_put_contents($root . "/bad\xff.php", 'x');
        $this->env->put('themes/demo/secret.php', 'x');
        chmod($root . '/secret.php', 0000);

        $item = (new ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        $result = $this->all(new Manifest($this->storage, $this->env, 3, 1024), $item);
        $reasons = array();
        foreach ($result['skipped'] as $skip) {
            $reasons[$skip['path']] = $skip['reason'];
        }
        $this->assertSame('hardDenied', $reasons['.git']);
        $this->assertSame('hardDenied', $reasons['CLAUDE.md']);
        $this->assertSame('tooLarge', $reasons['big.bin']);
        $this->assertSame('symlink', $reasons['etc-link']);
        $this->assertSame('symlink', $reasons['style-link.css']);
        $this->assertSame('notUtf8', $reasons["bad\xff.php"]);
        if (function_exists('posix_geteuid') && posix_geteuid() !== 0) {
            $this->assertSame('unreadable', $reasons['secret.php']);
        }
        $listed = array_column($result['entries'], 'path');
        $this->assertNotContains('.git/HEAD', $listed);
        $this->assertNotContains('etc-link/passwd', $listed);
        // The invalid name survives JSON on the way out.
        $data = $this->assertOk($this->call('/items/manifest', array('item' => array('kind' => 'theme', 'slug' => 'demo')), array('connectionId' => $this->connect())));
        $this->assertContains("bad\u{FFFD}.php", array_column($data['skipped'], 'path'));
        chmod($root . '/secret.php', 0644);
    }

    public function testHashCacheIsUsedAndInvalidatedBySizeOrMtime(): void
    {
        $files = $this->theme();
        $item = (new ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        $manifest = new Manifest($this->storage, $this->env, 2000);
        // Files written this second are never cached: their mtime cannot tell two versions apart.
        $manifest->page($item, null, 10.0);
        $this->assertCount(0, $this->storage->hashes);
        foreach (array_keys($files) as $path) {
            touch($item['real'] . '/' . $path, time() - 100);
        }
        clearstatcache();
        $manifest->page($item, null, 10.0);
        $this->assertCount(8, $this->storage->hashes);
        // Poison the cache for style.css: a hit shows the cached value.
        $key = hash('sha256', $item['real'] . '/style.css');
        $this->storage->hashes[$key]['sha256'] = str_repeat('0', 64);
        $entries = array_column($manifest->page($item, null, 10.0)['entries'], 'sha256', 'path');
        $this->assertSame(str_repeat('0', 64), $entries['style.css']);
        // A change in mtime makes it hash again.
        touch($item['real'] . '/style.css', time() + 100);
        clearstatcache();
        $entries = array_column($manifest->page($item, null, 10.0)['entries'], 'sha256', 'path');
        $this->assertSame(hash('sha256', 'body{}'), $entries['style.css']);
    }

    public function testTooManyFilesStopsTheListing(): void
    {
        $this->theme();
        $item = (new ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        $page = (new Manifest($this->storage, $this->env, 2000, 1024, 5))->page($item, null, 10.0);
        $this->assertCount(5, $page['entries']);
        $this->assertSame('tooMany', end($page['skipped'])['reason']);
        $this->assertNull($page['cursor']);
    }

    public function testSingleFilePlugin(): void
    {
        $this->env->put('plugins/hello.php', '<?php // hello');
        $data = $this->assertOk($this->call('/items/manifest', array('item' => array('kind' => 'plugin', 'slug' => 'hello.php')), array('connectionId' => $this->connect())));
        $this->assertTrue($data['isFile']);
        $this->assertSame(array(array('path' => 'hello.php', 'size' => 14, 'sha256' => hash('sha256', '<?php // hello'))), $data['entries']);
        $this->assertNull($data['cursor']);
    }

    public function testItemChecks(): void
    {
        $connection = $this->connect();
        $this->env->put('plugins/runova-connector/runova-connector.php', '<?php');
        $this->env->put('mu-plugins/00-runova-connector-guard.php', '<?php');
        $this->env->put('plugins/real/real.php', '<?php');
        symlink($this->env->content . '/plugins/real', $this->env->content . '/plugins/linked');
        $cases = array(
            array(array('kind' => 'plugin', 'slug' => 'runova-connector'), 'itemProtected'),
            array(array('kind' => 'mu-plugin', 'slug' => '00-runova-connector-guard.php'), 'itemProtected'),
            array(array('kind' => 'plugin', 'slug' => 'missing'), 'itemUnknown'),
            array(array('kind' => 'theme', 'slug' => '..'), 'pathRejected'),
            array(array('kind' => 'theme', 'slug' => 'a b'), 'badRequest'),
            array(array('kind' => 'theme', 'slug' => '.git'), 'pathRejected'),
            array(array('kind' => 'theme', 'slug' => 'con'), 'pathRejected'),
            array(array('kind' => 'widget', 'slug' => 'x'), 'badRequest'),
            array(array('kind' => 'plugin', 'slug' => 'linked'), 'pathRejected'),
            array('theme', 'badRequest'),
        );
        foreach ($cases as $case) {
            $result = $this->call('/items/manifest', array('item' => $case[0]), array('connectionId' => $connection));
            $this->assertError($case[1], $result);
        }
    }

    public function testDataFolderInsideAnItemIsProtected(): void
    {
        $this->env->put('plugins/holder/holder.php', '<?php');
        $this->env->dataDir = $this->env->content . '/plugins/holder/data';
        mkdir($this->env->dataDir);
        $result = $this->call('/items/manifest', array('item' => array('kind' => 'plugin', 'slug' => 'holder')), array('connectionId' => $this->connect()));
        $this->assertError('itemProtected', $result);
    }

    public function testBadCursorIsRefused(): void
    {
        $this->theme();
        $result = $this->call('/items/manifest', array('item' => array('kind' => 'theme', 'slug' => 'demo'), 'cursor' => '../../etc'), array('connectionId' => $this->connect()));
        $this->assertError('badRequest', $result);
    }

    public function testPulledIsAuditedOncePerItemAndWindow(): void
    {
        $this->theme();
        $connection = $this->connect();
        for ($index = 0; $index < 3; $index++) {
            $this->call('/items/manifest', array('item' => array('kind' => 'theme', 'slug' => 'demo')), array('connectionId' => $connection));
        }
        $events = array_column($this->storage->audit, 'event');
        $this->assertSame(1, count(array_keys($events, 'pulled', true)));
    }
}
