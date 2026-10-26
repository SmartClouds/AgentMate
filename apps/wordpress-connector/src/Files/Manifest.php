<?php
/**
 * Lists an item's files with their size and SHA-256, a page at a time. The walk is depth-first in
 * a fixed order (see Paths::compare), so the cursor is just the last path a page covered. Symlinks,
 * unreadable files, names that are not UTF-8, files over the size cap and paths the policy refuses
 * are reported as skipped and never followed. Hashes are cached by path, size and mtime.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Env\Environment;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Protocol;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Text;

final class Manifest
{
    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var int */
    private $pageSize;

    /** @var int */
    private $maxFileBytes;

    /** @var int */
    private $maxFiles;

    public function __construct(Storage $storage, Environment $env, int $pageSize, int $maxFileBytes = Protocol::MAX_FILE_BYTES, int $maxFiles = Protocol::MAX_FILES_PER_ITEM)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->pageSize = max(1, $pageSize);
        $this->maxFileBytes = $maxFileBytes;
        $this->maxFiles = $maxFiles;
    }

    /**
     * One WpManifestResponse page.
     *
     * @param array{kind: string, slug: string, path: string, real: string, isFile: bool} $item
     * @param mixed $cursor
     * @return array{isFile: bool, entries: array<int, array<string, mixed>>, skipped: array<int, array<string, string>>, cursor: string|null}
     */
    public function page(array $item, $cursor, float $budgetSeconds): array
    {
        if ($item['isFile']) {
            return $this->singleFile($item);
        }
        $position = self::readCursor($cursor);
        $listed = $position['n'];
        $records = array();
        $more = false;
        $tooMany = false;
        $pending = 0;
        foreach ($this->walk($item['real'], '', $position['p']) as $record) {
            if (count($records) >= $this->pageSize) {
                $more = true;
                break;
            }
            if ($record['type'] === 'file') {
                if ($listed + $pending >= $this->maxFiles) {
                    $records[] = array('type' => 'skip', 'path' => $record['path'], 'reason' => 'tooMany');
                    $tooMany = true;
                    break;
                }
                $record = $this->statFile($record);
                if ($record['type'] === 'file') {
                    $pending++;
                }
            }
            $records[] = $record;
        }

        $keys = array();
        foreach ($records as $record) {
            if ($record['type'] === 'file' && !$record['fresh']) {
                $keys[$record['key']] = array('size' => $record['size'], 'mtime' => $record['mtime']);
            }
        }
        $cached = count($keys) > 0 ? $this->storage->getHashes($keys) : array();

        $entries = array();
        $skipped = array();
        $last = null;
        $stopped = false;
        $now = $this->env->now();
        foreach ($records as $record) {
            if ($record['type'] === 'file') {
                $sha = isset($cached[$record['key']]) ? $cached[$record['key']] : null;
                if ($sha === null) {
                    // Always finish at least one record, so every page moves the cursor on.
                    if ($last !== null && $this->env->elapsed() > $budgetSeconds) {
                        $stopped = true;
                        break;
                    }
                    $sha = self::hashFile($record['abs']);
                    if ($sha === null) {
                        $skipped[] = array('path' => $record['path'], 'reason' => 'unreadable');
                        $last = $record['path'];
                        continue;
                    }
                    if (!$record['fresh']) {
                        $this->storage->putHash($record['key'], $record['size'], $record['mtime'], $sha, $now);
                    }
                }
                $entries[] = array('path' => $record['path'], 'size' => $record['size'], 'sha256' => $sha);
                $listed++;
            } else {
                $skipped[] = array('path' => $record['path'], 'reason' => $record['reason']);
            }
            $last = $record['path'];
        }

        $next = null;
        if (!$tooMany && ($more || $stopped) && $last !== null) {
            $next = self::writeCursor($listed, $last);
        }
        return array('isFile' => false, 'entries' => $entries, 'skipped' => $skipped, 'cursor' => $next);
    }

    /**
     * @param array{kind: string, slug: string, path: string, real: string, isFile: bool} $item
     * @return array{isFile: bool, entries: array<int, array<string, mixed>>, skipped: array<int, array<string, string>>, cursor: null}
     */
    private function singleFile(array $item): array
    {
        $record = $this->statFile(array('type' => 'file', 'path' => $item['slug'], 'abs' => $item['real']));
        if ($record['type'] !== 'file') {
            return array('isFile' => true, 'entries' => array(), 'skipped' => array(array('path' => $record['path'], 'reason' => $record['reason'])), 'cursor' => null);
        }
        $sha = $this->hashCached($record);
        if ($sha === null) {
            return array('isFile' => true, 'entries' => array(), 'skipped' => array(array('path' => $item['slug'], 'reason' => 'unreadable')), 'cursor' => null);
        }
        return array(
            'isFile' => true,
            'entries' => array(array('path' => $item['slug'], 'size' => $record['size'], 'sha256' => $sha)),
            'skipped' => array(),
            'cursor' => null,
        );
    }

    /**
     * The whole-file hash, from the cache when the size and mtime still match.
     *
     * @param array<string, mixed> $record a stat'ed file record
     */
    public function hashCached(array $record): ?string
    {
        if (!$record['fresh']) {
            $cached = $this->storage->getHashes(array($record['key'] => array('size' => $record['size'], 'mtime' => $record['mtime'])));
            if (isset($cached[$record['key']])) {
                return $cached[$record['key']];
            }
        }
        $sha = self::hashFile($record['abs']);
        if ($sha !== null && !$record['fresh']) {
            $this->storage->putHash($record['key'], $record['size'], $record['mtime'], $sha, $this->env->now());
        }
        return $sha;
    }

    /**
     * Adds size, mtime and the cache key to a file record, or turns it into a skip.
     *
     * @param array<string, mixed> $record
     * @return array<string, mixed>
     */
    public function statFile(array $record): array
    {
        clearstatcache(true, $record['abs']);
        if (!is_readable($record['abs'])) {
            return array('type' => 'skip', 'path' => $record['path'], 'reason' => 'unreadable');
        }
        $size = filesize($record['abs']);
        $mtime = filemtime($record['abs']);
        if (!is_int($size) || !is_int($mtime)) {
            return array('type' => 'skip', 'path' => $record['path'], 'reason' => 'unreadable');
        }
        if ($size > $this->maxFileBytes) {
            return array('type' => 'skip', 'path' => $record['path'], 'reason' => 'tooLarge');
        }
        $record['size'] = $size;
        $record['mtime'] = $mtime;
        $record['key'] = hash('sha256', $record['abs']);
        // mtime has one-second steps: a file written this second may change again with the same
        // size and mtime, so its hash is never cached or trusted from the cache.
        $record['fresh'] = $mtime >= time() - 2;
        return $record;
    }

    private static function hashFile(string $path): ?string
    {
        $sha = @hash_file('sha256', $path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- an unreadable file is reported, not warned about.
        return is_string($sha) ? $sha : null;
    }

    /**
     * Depth-first, entries in byte order, resuming after $cursor.
     *
     * @return \Generator<int, array<string, mixed>>
     */
    private function walk(string $dir, string $prefix, ?string $cursor): \Generator
    {
        $names = @scandir($dir, SCANDIR_SORT_NONE); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        if (!is_array($names)) {
            if ($prefix !== '') {
                yield array('type' => 'skip', 'path' => $prefix, 'reason' => 'unreadable');
            }
            return;
        }
        $names = array_values(array_filter($names, function ($name) {
            return $name !== '.' && $name !== '..';
        }));
        usort($names, 'strcmp');
        foreach ($names as $name) {
            $path = $prefix === '' ? $name : $prefix . '/' . $name;
            if ($cursor !== null) {
                $order = Paths::compare($path, $cursor);
                if ($order === 0 || ($order < 0 && !Paths::isAncestor($path, $cursor))) {
                    continue;
                }
            }
            $abs = $dir . '/' . $name;
            if (!Text::isUtf8($name)) {
                yield array('type' => 'skip', 'path' => $path, 'reason' => 'notUtf8');
                continue;
            }
            if (is_link($abs)) {
                yield array('type' => 'skip', 'path' => $path, 'reason' => 'symlink');
                continue;
            }
            $reason = PathPolicy::validate($path);
            if ($reason !== null) {
                yield array('type' => 'skip', 'path' => $path, 'reason' => $reason);
                continue;
            }
            if (is_dir($abs)) {
                // Junctions and other links is_link() may miss: the real path must be where we are.
                if (Paths::containedReal($abs, $abs) === null) {
                    yield array('type' => 'skip', 'path' => $path, 'reason' => 'symlink');
                    continue;
                }
                yield from $this->walk($abs, $path, $cursor);
                continue;
            }
            if (!is_file($abs)) {
                yield array('type' => 'skip', 'path' => $path, 'reason' => 'unreadable');
                continue;
            }
            yield array('type' => 'file', 'path' => $path, 'abs' => $abs);
        }
    }

    /**
     * @param mixed $cursor
     * @return array{n: int, p: string|null}
     */
    private static function readCursor($cursor): array
    {
        if ($cursor === null) {
            return array('n' => 0, 'p' => null);
        }
        if (!is_string($cursor) || preg_match('/^([0-9]{1,9})\.([A-Za-z0-9_-]+)$/D', $cursor, $match) !== 1) {
            throw ApiError::badRequest('That cursor is not one this site gave out.');
        }
        $path = Base64Url::decode($match[2]);
        if ($path === null || $path === '') {
            throw ApiError::badRequest('That cursor is not one this site gave out.');
        }
        return array('n' => (int) $match[1], 'p' => $path);
    }

    private static function writeCursor(int $listed, string $path): string
    {
        return $listed . '.' . Base64Url::encode($path);
    }
}
