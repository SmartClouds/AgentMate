<?php
/**
 * The pieces under the deploy: syntax check, atomic writes, staging and the health verdict.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Deploy\Staging;
use Runova\Connector\Deploy\SyntaxCheck;
use Runova\Connector\Files\AtomicWriter;
use Runova\Connector\Storage\MemoryStorage;
use Runova\Connector\Tests\Support\TestCase;

final class DeployPartsTest extends TestCase
{
    public function testSyntaxCheck(): void
    {
        $this->assertTrue(SyntaxCheck::available());
        $this->assertNull(SyntaxCheck::check("<?php\necho 'fine';\n"));
        $this->assertNull(SyntaxCheck::check('<h1>Just HTML</h1>'));
        $this->assertNull(SyntaxCheck::check("<?php\nfunction a(): ?int { return null; }\n"));
        $error = SyntaxCheck::check("<?php\n\nif (true {\n\n");
        // PHP reports the line where it gave up, which differs a little between versions.
        $this->assertContains($error['line'], array(3, 4, 5));
        $this->assertSame(2, SyntaxCheck::check("<?php\n\$a = ;\n")['line']);
        $this->assertNotNull(SyntaxCheck::check('<?php $a = ;'));
        $this->assertTrue(SyntaxCheck::isPhp('a/b.PHP'));
        $this->assertTrue(SyntaxCheck::isPhp('x.phtml'));
        $this->assertFalse(SyntaxCheck::isPhp('style.css'));
    }

    public function testAtomicWriterReplacesAndFallsBackLikeWindows(): void
    {
        $dir = $this->tempDir();
        file_put_contents($dir . '/source', 'new');
        file_put_contents($dir . '/target', 'old');
        $attempts = array();
        $writer = new AtomicWriter(function (string $from, string $to) use (&$attempts): bool {
            $attempts[] = file_exists($to) ? 'exists' : 'free';
            return file_exists($to) ? false : rename($from, $to);
        });
        $writer->copy($dir . '/source', $dir . '/target', 0640);
        $this->assertSame('new', file_get_contents($dir . '/target'));
        $this->assertSame(array('exists', 'free'), $attempts);
        $this->assertSame(0640, fileperms($dir . '/target') & 0777);
        $this->assertSame(array('source', 'target'), array_values(array_diff(scandir($dir), array('.', '..'))));

        $never = new AtomicWriter(function (): bool {
            return false;
        });
        try {
            $never->copy($dir . '/source', $dir . '/other', 0644);
            $this->fail('A rename that never works must throw.');
        } catch (\RuntimeException $expected) {
            $this->assertSame(array('source', 'target'), array_values(array_diff(scandir($dir), array('.', '..'))), 'No temp file is left.');
        }
        file_put_contents($dir . '/' . AtomicWriter::TEMP_PREFIX . 'abc', 'stray');
        AtomicWriter::sweep($dir);
        $this->assertFileDoesNotExist($dir . '/' . AtomicWriter::TEMP_PREFIX . 'abc');
    }

    public function testStagingIsContentAddressedAndProtected(): void
    {
        $data = $this->tempDir() . '/runova-connector-0123456789ab';
        $staging = new Staging($data);
        $sha = $staging->storeBytes('hello');
        $this->assertSame(hash('sha256', 'hello'), $sha);
        $this->assertSame($data . '/blobs/' . $sha, $staging->blobPath($sha));
        $this->assertTrue($staging->has($sha, 5));
        $this->assertFalse($staging->has($sha, 6));
        foreach (array('.htaccess', 'web.config', 'index.php', 'blobs/index.php') as $guard) {
            $this->assertFileExists($data . '/' . $guard);
        }
        $staging->append('d1', 0, 'wor');
        $staging->append('d1', 0, 'ld');
        $this->assertSame(5, $staging->partSize('d1', 0));
        $this->assertFalse($staging->finish('d1', 0, hash('sha256', 'nope!'), 5));
        $this->assertSame(0, $staging->partSize('d1', 0), 'A bad upload is dropped.');
        $staging->append('d1', 0, 'world');
        $this->assertTrue($staging->finish('d1', 0, hash('sha256', 'world'), 5));
        $this->assertSame(1, $staging->collect(array($sha)));
        $this->assertTrue($staging->has($sha, 5));
        $this->assertFalse($staging->has(hash('sha256', 'world'), 5));
        $this->expectException(\InvalidArgumentException::class);
        $staging->blobPath('../../etc/passwd');
    }

    public function testHealthVerdict(): void
    {
        $ok = array('name' => 'home', 'status' => 200, 'ok' => true, 'detail' => '');
        $bad = array('name' => 'home', 'status' => 500, 'ok' => false, 'detail' => '');
        $unknown = array('name' => 'home', 'status' => null, 'ok' => null, 'detail' => '');
        $this->assertTrue(DeployService::health(array($ok), array($ok)));
        $this->assertFalse(DeployService::health(array($ok), array($bad)));
        $this->assertNull(DeployService::health(array($unknown), array($bad)), 'Broken before is not a regression.');
        $this->assertNull(DeployService::health(array($bad), array($bad)));
        $this->assertNull(DeployService::health(array($ok), array($unknown)));
    }

    public function testKvAddIsALock(): void
    {
        $storage = new MemoryStorage();
        $this->assertTrue($storage->kvAdd('lock', 'a', 100, 50));
        $this->assertFalse($storage->kvAdd('lock', 'b', 100, 60));
        $this->assertTrue($storage->kvAdd('lock', 'c', null, 100), 'An expired holder no longer counts.');
        $this->assertSame('c', $storage->kvGet('lock', 100));
    }
}
