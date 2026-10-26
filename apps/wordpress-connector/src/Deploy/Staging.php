<?php
/**
 * Uploaded and snapshotted file contents, in the plugin's private data folder:
 *   blobs/<sha256>          whole files, content-addressed, no extension (never runnable)
 *   parts/<deploy>-<op>     uploads still arriving
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Deploy;

use Runova\Connector\Support\DataDir;

final class Staging
{
    const SHA = '/^[0-9a-f]{64}$/D';
    const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    /** @var string */
    private $root;

    public function __construct(string $dataDir)
    {
        $this->root = rtrim($dataDir, '/\\');
    }

    private function dir(string $name): string
    {
        if (!is_dir($this->root)) {
            if (!@mkdir($this->root, 0755, true) && !is_dir($this->root)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
                throw new \RuntimeException('The Runova data folder could not be created.');
            }
            DataDir::protect($this->root);
        }
        $dir = $this->root . '/' . $name;
        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0755) && !is_dir($dir)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
                throw new \RuntimeException('A staging folder could not be created.');
            }
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
            file_put_contents($dir . '/index.php', DataDir::INDEX);
        }
        return $dir;
    }

    public function blobPath(string $sha): string
    {
        if (preg_match(self::SHA, $sha) !== 1) {
            throw new \InvalidArgumentException('Not a sha256.');
        }
        return $this->dir('blobs') . '/' . $sha;
    }

    /** True when the content with this hash and size is staged (empty content always is). */
    public function has(string $sha, int $size): bool
    {
        if ($sha === self::EMPTY_SHA && $size === 0) {
            $this->storeBytes('');
            return true;
        }
        $path = $this->blobPath($sha);
        clearstatcache(true, $path);
        return is_file($path) && filesize($path) === $size;
    }

    private function partPath(string $deployId, int $op): string
    {
        if (preg_match('/^[A-Za-z0-9-]{1,64}$/D', $deployId) !== 1) {
            throw new \InvalidArgumentException('Not a deploy id.');
        }
        return $this->dir('parts') . '/' . $deployId . '-' . $op;
    }

    public function partSize(string $deployId, int $op): int
    {
        $path = $this->partPath($deployId, $op);
        clearstatcache(true, $path);
        return is_file($path) ? (int) filesize($path) : 0;
    }

    public function append(string $deployId, int $op, string $bytes): void
    {
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
        if (file_put_contents($this->partPath($deployId, $op), $bytes, FILE_APPEND) !== strlen($bytes)) {
            throw new \RuntimeException('An upload could not be written to the staging folder.');
        }
    }

    /**
     * Turns a complete upload into a blob. False (and the part is dropped) when the bytes do not
     * hash to what the deploy promised.
     */
    public function finish(string $deployId, int $op, string $sha, int $size): bool
    {
        $part = $this->partPath($deployId, $op);
        clearstatcache(true, $part);
        if (!is_file($part) || filesize($part) !== $size || hash_file('sha256', $part) !== $sha) {
            @unlink($part); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            return false;
        }
        $blob = $this->blobPath($sha);
        if (is_file($blob)) {
            @unlink($part); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            return true;
        }
        // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
        return @rename($part, $blob) || is_file($blob); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
    }

    /**
     * Copies a file on the site into the blob store (for snapshots).
     *
     * @return array{sha256: string, size: int}
     */
    public function storeFile(string $path): array
    {
        $sha = hash_file('sha256', $path);
        $size = filesize($path);
        if (!is_string($sha) || !is_int($size)) {
            throw new \RuntimeException('Could not read ' . basename($path) . ' to keep a copy.');
        }
        $blob = $this->blobPath($sha);
        if (!is_file($blob)) {
            $temp = $blob . '.' . bin2hex(random_bytes(4));
            if (!@copy($path, $temp) || hash_file('sha256', $temp) !== $sha) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                @unlink($temp); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                throw new \RuntimeException('Could not keep a copy of ' . basename($path) . '; it changed while being read.');
            }
            // phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename
            if (!@rename($temp, $blob) && !is_file($blob)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                throw new \RuntimeException('Could not keep a copy of ' . basename($path) . '.');
            }
            @unlink($temp); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        }
        return array('sha256' => $sha, 'size' => $size);
    }

    public function storeBytes(string $bytes): string
    {
        $sha = hash('sha256', $bytes);
        $blob = $this->blobPath($sha);
        if (!is_file($blob)) {
            // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
            file_put_contents($blob, $bytes);
        }
        return $sha;
    }

    public function readBlob(string $sha, int $max): ?string
    {
        $path = $this->blobPath($sha);
        if (!is_file($path) || filesize($path) > $max) {
            return null;
        }
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        $bytes = file_get_contents($path);
        return is_string($bytes) ? $bytes : null;
    }

    /** Drops partial uploads, except those of the deploys named. */
    public function dropParts(array $keepDeployIds): void
    {
        $dir = $this->dir('parts');
        foreach ((array) scandir($dir) as $name) {
            if (!is_string($name) || $name === '.' || $name === '..' || $name === 'index.php') {
                continue;
            }
            $deploy = (string) preg_replace('/-[0-9]+$/', '', $name);
            if (!in_array($deploy, $keepDeployIds, true)) {
                @unlink($dir . '/' . $name); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            }
        }
    }

    /**
     * Deletes blobs nothing refers to any more.
     *
     * @param string[] $keep hashes still needed
     */
    public function collect(array $keep): int
    {
        $keep = array_flip($keep);
        $dir = $this->dir('blobs');
        $removed = 0;
        foreach ((array) scandir($dir) as $name) {
            if (!is_string($name) || isset($keep[$name])) {
                continue;
            }
            if (preg_match(self::SHA, $name) === 1 || preg_match('/^[0-9a-f]{64}\.[0-9a-f]{8}$/D', $name) === 1) {
                @unlink($dir . '/' . $name); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                $removed++;
            }
        }
        return $removed;
    }
}
