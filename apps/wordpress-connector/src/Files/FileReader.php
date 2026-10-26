<?php
/**
 * Reads a batch of files from one item, one blob per requested file, in order. Each result carries
 * the whole file's size and hash, so a client reading a big file in pieces can check the result.
 * The batch stops adding bytes once the response budget is spent: files past that point come back
 * with length 0 and the client asks again from offset + length.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

use Runova\Connector\Http\ApiError;
use Runova\Connector\Protocol;

final class FileReader
{
    /** @var Manifest */
    private $manifest;

    /** @var int */
    private $maxFileBytes;

    public function __construct(Manifest $manifest, int $maxFileBytes = Protocol::MAX_FILE_BYTES)
    {
        $this->manifest = $manifest;
        $this->maxFileBytes = $maxFileBytes;
    }

    /**
     * @param array{kind: string, slug: string, path: string, real: string, isFile: bool} $item
     * @param mixed $files the request's `files`
     * @return array{files: array<int, array<string, mixed>>, blobs: string[]}
     */
    public function read(array $item, $files, int $maxResponseBytes, int $maxPaths): array
    {
        if (!is_array($files) || count($files) === 0 || array_values($files) !== $files) {
            throw ApiError::badRequest('Ask for at least one file.');
        }
        if (count($files) > $maxPaths) {
            throw ApiError::badRequest('Too many files in one read.', array('maxPathsPerRead' => $maxPaths));
        }
        $wanted = array();
        foreach ($files as $file) {
            $wanted[] = $this->check($item, $file);
        }

        $results = array();
        $blobs = array();
        $budget = $maxResponseBytes;
        foreach ($wanted as $want) {
            list($result, $blob) = $this->readOne($item, $want, $budget);
            $budget -= strlen($blob);
            $results[] = $result;
            $blobs[] = $blob;
        }
        return array('files' => $results, 'blobs' => $blobs);
    }

    /**
     * Validates one request entry before anything is read.
     *
     * @param array{kind: string, slug: string, path: string, real: string, isFile: bool} $item
     * @param mixed $file
     * @return array{path: string, offset: int, length: int|null}
     */
    private function check(array $item, $file): array
    {
        if (!is_array($file) || !isset($file['path']) || !is_string($file['path'])) {
            throw ApiError::badRequest('Each file needs a path.');
        }
        $path = $file['path'];
        $offset = array_key_exists('offset', $file) ? $file['offset'] : 0;
        $length = array_key_exists('length', $file) ? $file['length'] : null;
        if (!is_int($offset) || $offset < 0 || ($length !== null && (!is_int($length) || $length < 0))) {
            throw ApiError::badRequest('An offset or length is not a whole number of bytes.', array('path' => $path));
        }
        if ($item['isFile']) {
            if ($path !== $item['slug']) {
                throw new ApiError('pathRejected', 'A single-file item has only one path: its own name.', array('path' => $path, 'reason' => 'traversal'));
            }
        } else {
            $reason = PathPolicy::validate($path);
            if ($reason !== null) {
                throw new ApiError('pathRejected', 'That path is not allowed.', array('path' => $path, 'reason' => $reason));
            }
        }
        return array('path' => $path, 'offset' => $offset, 'length' => $length);
    }

    /**
     * @param array{kind: string, slug: string, path: string, real: string, isFile: bool} $item
     * @param array{path: string, offset: int, length: int|null} $want
     * @return array{0: array<string, mixed>, 1: string}
     */
    private function readOne(array $item, array $want, int $budget): array
    {
        $abs = $item['isFile'] ? $item['real'] : $item['real'] . '/' . $want['path'];
        $missing = array(
            'path' => $want['path'],
            'offset' => $want['offset'],
            'length' => 0,
            'size' => 0,
            'sha256' => '',
            'missing' => true,
        );
        if (is_link($abs)) {
            throw new ApiError('pathRejected', 'That path is a symlink, which is never read.', array('path' => $want['path'], 'reason' => 'symlink'));
        }
        $parent = dirname($abs);
        if (!$item['isFile'] && file_exists($parent) && Paths::containedReal($parent, $parent) === null) {
            throw new ApiError('pathRejected', 'That path leads outside its item.', array('path' => $want['path'], 'reason' => 'symlink'));
        }
        if (!file_exists($abs)) {
            return array($missing, '');
        }
        if (Paths::containedReal($abs, $abs) === null) {
            throw new ApiError('pathRejected', 'That path leads outside its item.', array('path' => $want['path'], 'reason' => 'symlink'));
        }
        if (!is_file($abs)) {
            throw ApiError::badRequest('That path is a folder, not a file.', array('path' => $want['path']));
        }
        $record = $this->manifest->statFile(array('type' => 'file', 'path' => $want['path'], 'abs' => $abs));
        if ($record['type'] !== 'file') {
            if ($record['reason'] === 'tooLarge') {
                // Not a tooLarge error: that one tells the client to halve its batch.
                throw new ApiError('pathRejected', 'That file is larger than the connector syncs.', array('path' => $want['path'], 'reason' => 'tooLarge', 'maxFileBytes' => $this->maxFileBytes));
            }
            return array($missing, '');
        }
        $sha = $this->manifest->hashCached($record);
        if ($sha === null) {
            return array($missing, '');
        }
        $size = $record['size'];
        $offset = min($want['offset'], $size);
        $length = $want['length'] === null ? $size - $offset : min($want['length'], $size - $offset);
        $length = max(0, min($length, $budget));
        $blob = '';
        if ($length > 0) {
            $handle = @fopen($abs, 'rb'); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_fopen
            if ($handle === false) {
                return array($missing, '');
            }
            $read = stream_get_contents($handle, $length, $offset);
            fclose($handle); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose
            $blob = is_string($read) ? $read : '';
        }
        return array(
            array(
                'path' => $want['path'],
                'offset' => $offset,
                'length' => strlen($blob),
                'size' => $size,
                'sha256' => $sha,
            ),
            $blob,
        );
    }
}
