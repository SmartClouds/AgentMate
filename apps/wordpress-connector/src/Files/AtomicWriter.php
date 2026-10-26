<?php
/**
 * Replaces files without ever leaving a half-written one in place: the new content goes to a
 * temporary file in the same folder, which is then renamed over the target. Windows refuses to
 * rename onto a file that exists or is open, so a failed rename is retried after removing the
 * target.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

final class AtomicWriter
{
    /** Temporary files start with this, so a crash leaves something recognisable to clean up. */
    const TEMP_PREFIX = '.runova-tmp-';

    /** @var callable */
    private $rename;

    /**
     * @param callable|null $rename rename(from, to): bool; tests pass one that behaves like Windows
     */
    public function __construct(?callable $rename = null)
    {
        $this->rename = $rename !== null ? $rename : function (string $from, string $to): bool {
            return @rename($from, $to); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.rename_rename
        };
    }

    /** Copies $source over $target. */
    public function copy(string $source, string $target, int $mode): void
    {
        $temp = dirname($target) . '/' . self::TEMP_PREFIX . bin2hex(random_bytes(6));
        if (!@copy($source, $temp)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            throw new \RuntimeException('Could not write a temporary file next to ' . basename($target) . '.');
        }
        @chmod($temp, $mode); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_chmod
        $this->replace($temp, $target);
    }

    /** Moves $temp over $target. */
    public function replace(string $temp, string $target): void
    {
        if (call_user_func($this->rename, $temp, $target)) {
            return;
        }
        if (file_exists($target) && @unlink($target) && call_user_func($this->rename, $temp, $target)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            return;
        }
        @unlink($temp); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        throw new \RuntimeException('Could not put ' . basename($target) . ' in place.');
    }

    /** Removes temporary files a crash left in a folder. */
    public static function sweep(string $dir): void
    {
        $names = @scandir($dir); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        foreach (is_array($names) ? $names : array() as $name) {
            if (strncmp($name, self::TEMP_PREFIX, strlen(self::TEMP_PREFIX)) === 0 && is_file($dir . '/' . $name) && !is_link($dir . '/' . $name)) {
                @unlink($dir . '/' . $name); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            }
        }
    }
}
