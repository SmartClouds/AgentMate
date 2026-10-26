<?php
/**
 * How much one call may carry and how long it may work, from the PHP settings:
 * - request cap: min(post_max_size, upload_max_filesize) * 0.8, at most 16 MiB;
 * - response cap: a fifth of the memory still free, between 256 KiB and 16 MiB;
 * - time budget: max_execution_time * 0.5, clamped to 5..20 seconds;
 * - fixed caps: 64 MiB per file, 20,000 files per item, 2,000 manifest entries per page.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Info;

use Runova\Connector\Env\Environment;
use Runova\Connector\Protocol;

final class Limits
{
    const MAX_PATHS_PER_READ = 500;
    const MANIFEST_PAGE_SIZE = 2000;
    const MIN_RESPONSE_BYTES = 262144;
    /** What an authenticated bundle may inflate to, at most. */
    const MAX_DECODED_BYTES = 67108864;
    const MIN_DECODED_BYTES = 4194304;

    /**
     * php.ini shorthand to bytes: "128M", "1G", "512K", "1048576". -1 (or 0) means no limit.
     */
    public static function iniBytes(string $value): int
    {
        $value = strtolower(trim($value));
        if ($value === '') {
            return 0;
        }
        $number = (int) $value;
        if ($number <= 0) {
            return $number;
        }
        $unit = substr($value, -1);
        $factor = 1;
        if ($unit === 'g') {
            $factor = 1073741824;
        } elseif ($unit === 'm') {
            $factor = 1048576;
        } elseif ($unit === 'k') {
            $factor = 1024;
        }
        return (int) min(PHP_INT_MAX, $number * $factor);
    }

    public static function maxRequestBytes(string $postMaxSize, string $uploadMaxFilesize): int
    {
        $caps = array();
        foreach (array($postMaxSize, $uploadMaxFilesize) as $setting) {
            $bytes = self::iniBytes($setting);
            if ($bytes > 0) {
                $caps[] = $bytes;
            }
        }
        if (count($caps) === 0) {
            return Protocol::BATCH_MAX_BYTES;
        }
        return (int) min(Protocol::BATCH_MAX_BYTES, floor(min($caps) * 0.8));
    }

    public static function maxResponseBytes(string $memoryLimit, int $memoryUsed): int
    {
        $limit = self::iniBytes($memoryLimit);
        if ($limit <= 0) {
            return Protocol::BATCH_MAX_BYTES;
        }
        $free = max(0, $limit - $memoryUsed);
        return (int) max(self::MIN_RESPONSE_BYTES, min(Protocol::BATCH_MAX_BYTES, floor($free / 5)));
    }

    /** The most an authenticated bundle may inflate to before it is refused. */
    public static function maxDecodedBytes(string $memoryLimit, int $memoryUsed): int
    {
        $limit = self::iniBytes($memoryLimit);
        if ($limit <= 0) {
            return self::MAX_DECODED_BYTES;
        }
        $free = max(0, $limit - $memoryUsed);
        return (int) max(self::MIN_DECODED_BYTES, min(self::MAX_DECODED_BYTES, floor($free / 4)));
    }

    public static function timeBudgetSeconds(string $maxExecutionTime): int
    {
        $seconds = (int) $maxExecutionTime;
        if ($seconds <= 0) {
            return 20;
        }
        return (int) max(5, min(20, floor($seconds * 0.5)));
    }

    /**
     * The WpLimits object.
     *
     * @return array<string, int>
     */
    public static function forEnvironment(Environment $env): array
    {
        return array(
            'maxRequestBytes' => self::maxRequestBytes($env->iniGet('post_max_size'), $env->iniGet('upload_max_filesize')),
            'maxResponseBytes' => self::maxResponseBytes($env->iniGet('memory_limit'), $env->memoryUsage()),
            'maxFileBytes' => Protocol::MAX_FILE_BYTES,
            'timeBudgetSeconds' => self::timeBudgetSeconds($env->iniGet('max_execution_time')),
            'maxPathsPerRead' => self::MAX_PATHS_PER_READ,
            'manifestPageSize' => self::MANIFEST_PAGE_SIZE,
            'maxFilesPerItem' => Protocol::MAX_FILES_PER_ITEM,
        );
    }
}
