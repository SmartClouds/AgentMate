<?php
/**
 * The bundle as PHP received it: a temporary upload file. It is hashed straight from disk, so a
 * large upload is only read into memory after its signature has checked out.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

final class UploadedBundle implements Bundle
{
    /** @var string */
    private $path;

    /** @var int */
    private $size;

    /** @var string|null */
    private $sha256 = null;

    private function __construct(string $path, int $size)
    {
        $this->path = $path;
        $this->size = $size;
    }

    /**
     * Reads one entry of $_FILES. Null when there is no usable upload; $tooLarge is set when PHP
     * refused it for its size.
     *
     * @param mixed $file
     */
    public static function fromUpload($file, bool &$tooLarge): ?self
    {
        $tooLarge = false;
        if (!is_array($file) || !isset($file['error'], $file['tmp_name']) || !is_string($file['tmp_name'])) {
            return null;
        }
        $error = (int) $file['error'];
        if ($error === UPLOAD_ERR_INI_SIZE || $error === UPLOAD_ERR_FORM_SIZE) {
            $tooLarge = true;
            return null;
        }
        if ($error !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
            return null;
        }
        clearstatcache(true, $file['tmp_name']);
        $size = filesize($file['tmp_name']);
        if (!is_int($size)) {
            return null;
        }
        return new self($file['tmp_name'], $size);
    }

    public function size(): int
    {
        return $this->size;
    }

    public function sha256(): string
    {
        if ($this->sha256 === null) {
            $hash = hash_file('sha256', $this->path);
            $this->sha256 = is_string($hash) ? $hash : '';
        }
        return $this->sha256;
    }

    public function read(int $maxBytes): ?string
    {
        if ($this->size > $maxBytes) {
            return null;
        }
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- a local temp file.
        $bytes = file_get_contents($this->path, false, null, 0, $maxBytes + 1);
        if (!is_string($bytes) || strlen($bytes) > $maxBytes || strlen($bytes) !== $this->size) {
            return null;
        }
        // The hash was taken from the file on disk; make sure these are the same bytes.
        return hash('sha256', $bytes) === $this->sha256() ? $bytes : null;
    }
}
