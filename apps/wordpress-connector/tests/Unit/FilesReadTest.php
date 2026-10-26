<?php
/**
 * /files/read: blobs in order, offset and length, the response budget, missing files, and the
 * same path policy as writes.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Tests\Support\TestCase;

final class FilesReadTest extends TestCase
{
    /** @var string */
    private $connection;

    protected function setUp(): void
    {
        parent::setUp();
        $this->makeSite();
        $this->connection = $this->connect();
        $this->env->put('themes/demo/style.css', 'body{color:red}');
        $this->env->put('themes/demo/inc/a.php', '<?php echo 1;');
        $this->env->put('themes/demo/big.bin', str_repeat('0123456789', 1000));
    }

    private function read(array $files, string $slug = 'demo', string $kind = 'theme'): array
    {
        return $this->call('/files/read', array('item' => array('kind' => $kind, 'slug' => $slug), 'files' => $files), array('connectionId' => $this->connection));
    }

    public function testReadsFilesAsBlobsInOrder(): void
    {
        $result = $this->read(array(array('path' => 'inc/a.php'), array('path' => 'style.css')));
        $data = $this->assertOk($result);
        $this->assertSame(array(
            array('path' => 'inc/a.php', 'offset' => 0, 'length' => 13, 'size' => 13, 'sha256' => hash('sha256', '<?php echo 1;')),
            array('path' => 'style.css', 'offset' => 0, 'length' => 15, 'size' => 15, 'sha256' => hash('sha256', 'body{color:red}')),
        ), $data['files']);
        $this->assertSame('<?php echo 1;', $result['frame']->blob(0));
        $this->assertSame('body{color:red}', $result['frame']->blob(1));
    }

    public function testOffsetAndLength(): void
    {
        $result = $this->read(array(array('path' => 'big.bin', 'offset' => 5, 'length' => 7), array('path' => 'big.bin', 'offset' => 9995)));
        $data = $this->assertOk($result);
        $this->assertSame('5678901', $result['frame']->blob(0));
        $this->assertSame(7, $data['files'][0]['length']);
        $this->assertSame(10000, $data['files'][0]['size']);
        $this->assertSame(hash('sha256', str_repeat('0123456789', 1000)), $data['files'][0]['sha256']);
        $this->assertSame('56789', $result['frame']->blob(1));
        // Past the end is an empty read, not an error.
        $data = $this->assertOk($this->read(array(array('path' => 'big.bin', 'offset' => 20000))));
        $this->assertSame(10000, $data['files'][0]['offset']);
        $this->assertSame(0, $data['files'][0]['length']);
    }

    public function testResponseBudgetCutsLaterFiles(): void
    {
        // 1 MiB of memory left (the fake uses 20 MiB) gives the 256 KiB floor.
        $this->env->ini['memory_limit'] = '21M';
        $big = str_repeat('x', 300000);
        $this->env->put('themes/demo/one.bin', $big);
        $this->env->put('themes/demo/two.bin', $big);
        $result = $this->read(array(array('path' => 'one.bin'), array('path' => 'two.bin'), array('path' => 'style.css')));
        $data = $this->assertOk($result);
        $budget = 262144;
        $this->assertSame($budget, $data['files'][0]['length']);
        $this->assertSame(0, $data['files'][1]['length']);
        $this->assertSame(300000, $data['files'][1]['size']);
        $this->assertSame(0, $data['files'][2]['length']);
        $this->assertSame($budget, strlen($result['frame']->blob(0)));
    }

    public function testMissingFile(): void
    {
        $result = $this->read(array(array('path' => 'gone.php'), array('path' => 'style.css')));
        $data = $this->assertOk($result);
        $this->assertSame(array('path' => 'gone.php', 'offset' => 0, 'length' => 0, 'size' => 0, 'sha256' => '', 'missing' => true), $data['files'][0]);
        $this->assertSame('', $result['frame']->blob(0));
        $this->assertSame('body{color:red}', $result['frame']->blob(1));
    }

    public function testPathPolicyAppliesToReads(): void
    {
        foreach (array('../../../wp-config.php' => 'traversal', '/etc/passwd' => 'absolute', 'C:/x' => 'driveLetter', 'file.php::$DATA' => 'colon', 'inc/con.php' => 'reservedName', '.env' => 'hardDenied') as $path => $reason) {
            $result = $this->read(array(array('path' => 'style.css'), array('path' => $path)));
            $this->assertError('pathRejected', $result, 422);
            $this->assertSame($reason, $result['body']['error']['details']['reason'], $path);
        }
    }

    public function testSymlinksAreNeverFollowed(): void
    {
        $root = $this->env->content . '/themes/demo';
        symlink('/etc/passwd', $root . '/passwd');
        symlink('/etc', $root . '/etc');
        foreach (array('passwd', 'etc/passwd') as $path) {
            $result = $this->read(array(array('path' => $path)));
            $this->assertError('pathRejected', $result);
            $this->assertSame('symlink', $result['body']['error']['details']['reason'], $path);
        }
    }

    public function testFolderAndBadEntries(): void
    {
        $this->assertError('badRequest', $this->read(array(array('path' => 'inc'))));
        $this->assertError('badRequest', $this->read(array()));
        $this->assertError('badRequest', $this->read(array(array('path' => 'style.css', 'offset' => -1))));
        $this->assertError('badRequest', $this->read(array(array('path' => 'style.css', 'length' => 'all'))));
        $this->assertError('badRequest', $this->read(array_fill(0, 501, array('path' => 'style.css'))));
    }

    public function testOverTheFileCapIsRefusedWithoutHalvingTheBatch(): void
    {
        $item = (new \Runova\Connector\Files\ItemResolver($this->env))->resolve(array('kind' => 'theme', 'slug' => 'demo'));
        $manifest = new \Runova\Connector\Files\Manifest($this->storage, $this->env, 2000, 100);
        $reader = new \Runova\Connector\Files\FileReader($manifest, 100);
        try {
            $reader->read($item, array(array('path' => 'big.bin')), 1048576, 10);
            $this->fail('A file over the cap must be refused.');
        } catch (\Runova\Connector\Http\ApiError $error) {
            $this->assertSame('pathRejected', $error->errorCode);
            $this->assertSame('tooLarge', $error->details['reason']);
        }
    }

    public function testSingleFileItem(): void
    {
        $this->env->put('mu-plugins/loader.php', '<?php // loader');
        $result = $this->read(array(array('path' => 'loader.php')), 'loader.php', 'mu-plugin');
        $this->assertOk($result);
        $this->assertSame('<?php // loader', $result['frame']->blob(0));
        $this->assertError('pathRejected', $this->read(array(array('path' => 'other.php')), 'loader.php', 'mu-plugin'));
    }
}
