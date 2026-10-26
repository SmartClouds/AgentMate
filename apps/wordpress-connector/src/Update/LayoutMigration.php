<?php
/**
 * Moves a site from the bridge layout (the Runova code in the 1.63 folder, agentmate-connector/)
 * to its own folder, runova-connector/. Only a signed /connector/migrate call starts it, or the
 * button in wp-admin, or `wp runova migrate`; never a page load, which could race the 1.63
 * updater's own health check right after it installed the bridge.
 *
 * In order, with the deploy mutex held throughout:
 * 1. The running folder is copied (not renamed: this request still runs from it) to a dot folder
 *    beside it. The main file waiting in layout/ takes the place of the 1.63 one, it is parsed,
 *    and the folder is renamed into place.
 * 2. The guard is written for the new folder, and the 1.63 guard file is removed.
 * 3. The active plugin entry is swapped in the plugin options themselves, on every network. No
 *    activation hook runs, and above all not the bridge's deactivation hook, which would take the
 *    guard away.
 * 4. The loopback health checks run. A check that passed before and fails now puts everything
 *    back: the entry, the guard files and the new folder.
 * 5. The reply names the new endpoints, signed with the same site key as always.
 * 6. The old folder stays for a grace period (requests may still be running from it), then it is
 *    deleted directly. Never through delete_plugins(), which would run its uninstall.php.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Update;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Deploy\SyntaxCheck;
use Runova\Connector\Env\Environment;
use Runova\Connector\Guard\GuardInstaller;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Layout;
use Runova\Connector\Legacy;
use Runova\Connector\Support\Constants;
use Runova\Connector\Support\Text;

final class LayoutMigration
{
    /** The old folder's pending removal: {dir, at}. */
    const CLEANUP_OPTION = Legacy::OPTION_PREFIX . 'layout_cleanup';
    const CRON_HOOK = 'runova_connector_layout_cleanup';
    /** How long the old folder stays after a move. RUNOVA_CONNECTOR_MIGRATION_GRACE_SECONDS shortens it for tests. */
    const GRACE_SECONDS = 600;

    /** Files of the bridge that the Runova layout does not take along. */
    const BRIDGE_ONLY = array(Legacy::MAIN, 'guard/' . Legacy::GUARD_FILE);

    /** @var Environment */
    private $env;

    /** @var AuditLog */
    private $audit;

    /** @var DeployService */
    private $deploys;

    /** @var LayoutHost */
    private $host;

    /** @var callable */
    private $rename;

    /**
     * @param callable|null $rename rename(from, to): bool; tests pass one that fails on purpose
     */
    public function __construct(Environment $env, AuditLog $audit, DeployService $deploys, LayoutHost $host, ?callable $rename = null)
    {
        $this->env = $env;
        $this->audit = $audit;
        $this->deploys = $deploys;
        $this->host = $host;
        $this->rename = $rename !== null ? $rename : function (string $from, string $to): bool {
            return @rename($from, $to); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.rename_rename
        };
    }

    /**
     * @param array<string, mixed>|null $connection null when wp-admin or WP-CLI asked
     * @return array<string, mixed> WpConnectorMigrateResponse
     */
    public function migrate(?array $connection, string $ip): array
    {
        return $this->deploys->whileIdle(function () use ($connection, $ip) {
            return $this->run($connection, $ip);
        });
    }

    /**
     * @param array<string, mixed>|null $connection
     * @return array<string, mixed>
     */
    private function run(?array $connection, string $ip): array
    {
        $env = $this->env;
        $root = $env->itemRoot('plugin');
        $from = ConnectorUpdater::pluginDir($env);
        if ($env->layout() !== Layout::BRIDGE) {
            // Asked again after a reply that got lost: the move is done.
            return $this->reply('current', Layout::RUNOVA, $env->rescueUrl(), array());
        }
        $target = $root . '/' . Layout::SLUG;
        if (!is_file($from . '/' . Layout::STAGED_MAIN)) {
            throw $this->refused('badPackage', 'This copy of the connector does not hold the files for its new folder. Update it from Runova first.');
        }
        if (!is_dir($from) || is_link($from) || !is_writable($root)) {
            throw $this->refused('notReplaceable', 'WordPress cannot write to the plugins folder, so the connector cannot move to its new folder. It keeps working where it is.');
        }
        if (file_exists($target) || is_link($target)) {
            if (!$this->isOwnLeftover($target)) {
                throw $this->refused('notReplaceable', 'There is already a runova-connector folder in the plugins folder. Activate Runova Connector from there, or remove it, then try again.');
            }
            $this->remove($target);
        }
        $mu = $env->itemRoot('mu-plugin');
        $guardPath = $mu . '/' . GuardInstaller::FILE;
        $legacyGuardPath = $mu . '/' . Legacy::GUARD_FILE;
        $guardBefore = is_file($guardPath) ? (string) file_get_contents($guardPath) : null; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        $legacyGuardBefore = GuardInstaller::legacyIsOurs($mu) ? (string) file_get_contents($legacyGuardPath) : null; // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        $guarded = $guardBefore !== null || $legacyGuardBefore !== null;
        if ($guarded && !is_writable($mu)) {
            throw $this->refused('notReplaceable', 'The mu-plugins folder is not writable, so the guard cannot move with the connector. It keeps working where it is.');
        }

        $this->sweep($root);
        $new = $root . '/.runova-connector-new-' . bin2hex(random_bytes(6));
        try {
            $baseline = $env->healthChecks();
            $this->stage($from, $new);
        } catch (\Throwable $error) {
            $this->remove($new);
            throw $error;
        }
        if (!$this->move($new, $target)) {
            $this->remove($new);
            throw $this->refused('notReplaceable', 'PHP could not put the connector\'s new folder in place. It keeps working where it is.');
        }

        $undo = array();
        $putBack = function () use ($target, $guardPath, $guardBefore, $legacyGuardPath, $legacyGuardBefore, &$undo): void {
            $this->host->restoreActive($undo);
            $this->restoreFile($guardPath, $guardBefore);
            $this->restoreFile($legacyGuardPath, $legacyGuardBefore);
            $this->remove($target);
            $this->env->cleanCaches();
        };
        try {
            if ($guarded && !GuardInstaller::installAt($mu, $target)) {
                throw $this->refused('notReplaceable', 'The guard could not be moved to the connector\'s new folder, so nothing was changed.');
            }
            $undo = $this->host->swapActive(Legacy::BASENAME, Layout::BASENAME);
            $env->cleanCaches();
            $checks = $env->healthChecks();
        } catch (\Throwable $error) {
            $putBack();
            throw $error;
        }
        if (DeployService::health($baseline, $checks) === false) {
            $putBack();
            $this->audit->add('connectorRolledBack', $env->now(), $ip, 'Tried to move Runova Connector to its new folder; the site failed its health check, so it stays where it was.', $connection);
            return $this->reply('rolledBack', Layout::BRIDGE, $env->rescueUrl(), $checks);
        }

        $this->host->setCleanupJob(array('dir' => $from, 'at' => $env->now() + self::grace()));
        $this->audit->add('connectorUpdated', $env->now(), $ip, 'Moved Runova Connector ' . $env->pluginVersion() . ' to its own folder, ' . Layout::SLUG . '. The old folder is removed in a few minutes.', $connection);
        return $this->reply('migrated', Layout::RUNOVA, $this->host->rescueUrl($target . '/' . Layout::MAIN), $checks);
    }

    /**
     * @param array<int, array<string, mixed>> $checks
     * @return array<string, mixed>
     */
    private function reply(string $state, string $layout, ?string $rescueUrl, array $checks): array
    {
        return array(
            'state' => $state,
            'layout' => $layout,
            'version' => $this->env->pluginVersion(),
            'restUrl' => $this->env->restUrl(),
            'ajaxUrl' => $this->env->ajaxUrl(),
            'rescueUrl' => $rescueUrl,
            'checks' => $checks,
        );
    }

    /** Seconds the old folder stays after a move. */
    public static function grace(): int
    {
        $seconds = Constants::value('RUNOVA_CONNECTOR_MIGRATION_GRACE_SECONDS');
        return is_numeric($seconds) ? (int) max(0, min(self::GRACE_SECONDS, (int) $seconds)) : self::GRACE_SECONDS;
    }

    /**
     * Deletes the old folder once its grace period is over, if the move still stands. Runs from
     * WP-Cron and from the connector's own requests; does nothing at all most of the time.
     */
    public static function cleanUp(LayoutHost $host, int $now): void
    {
        $job = $host->cleanupJob();
        if ($job === null || $now < $job['at']) {
            return;
        }
        $host->setCleanupJob(null);
        $dir = rtrim($job['dir'], '/\\');
        if (basename($dir) !== Legacy::SLUG || is_link($dir) || !is_dir($dir) || !is_file($dir . '/' . Legacy::MAIN)) {
            return;
        }
        // Someone put the old copy back in use meanwhile, or the new one is gone: leave it.
        if ($host->isActive(Legacy::BASENAME) || !$host->isActive(Layout::BASENAME)) {
            return;
        }
        self::removeTree($dir);
    }

    // Files -----------------------------------------------------------------------------------

    /**
     * The running folder copied to $new, in the Runova layout: the main file from layout/ at the
     * top, the bridge-only files left out.
     */
    private function stage(string $from, string $new): void
    {
        $main = (string) file_get_contents($from . '/' . Layout::STAGED_MAIN); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        if (strpos(substr($main, 0, 8192), 'Plugin Name:       Runova Connector') === false) {
            throw $this->refused('badPackage', 'The main file for the new folder is not Runova Connector\'s.');
        }
        $error = SyntaxCheck::check($main);
        if ($error !== null) {
            throw new ApiError('syntaxError', 'The main file for the new folder does not parse on this site\'s PHP: line ' . $error['line'] . '.', array(
                'path' => Layout::MAIN,
                'line' => $error['line'],
                'message' => Text::clean($error['message'], 300),
            ));
        }
        if (!@mkdir($new, $this->env->dirMode())) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
            throw $this->refused('notReplaceable', 'WordPress cannot make a folder in the plugins folder, so the connector cannot move. It keeps working where it is.');
        }
        $this->copyTree($from, $new, '');
        $this->writeFile($new . '/' . Layout::MAIN, $main);
    }

    private function copyTree(string $from, string $to, string $relative): void
    {
        $names = @scandir($from . ($relative === '' ? '' : '/' . $relative)); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        foreach (is_array($names) ? $names : array() as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $path = $relative === '' ? $name : $relative . '/' . $name;
            $source = $from . '/' . $path;
            if (is_link($source) || $path === 'layout' || in_array($path, self::BRIDGE_ONLY, true)) {
                continue;
            }
            if (is_dir($source)) {
                if (!@mkdir($to . '/' . $path, $this->env->dirMode()) && !is_dir($to . '/' . $path)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
                    throw new ApiError('internal', 'The site could not make the connector\'s new folder. Is its disk full?');
                }
                $this->copyTree($from, $to, $path);
                continue;
            }
            $this->writeFile($to . '/' . $path, (string) file_get_contents($source)); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        }
    }

    private function writeFile(string $path, string $bytes): void
    {
        // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
        if (@file_put_contents($path, $bytes) !== strlen($bytes)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            throw new ApiError('internal', 'The site could not write the connector\'s new folder. Is its disk full?');
        }
        @chmod($path, $this->env->fileMode()); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_chmod
    }

    /** Puts a file back the way it was: its old bytes, or gone when there was none. */
    private function restoreFile(string $path, ?string $content): void
    {
        if ($content === null) {
            if (is_file($path)) {
                @unlink($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            }
            return;
        }
        GuardInstaller::write($path, $content);
    }

    /**
     * A runova-connector folder a crashed move left behind: our layout, our version, not active.
     * Anything else there belongs to the site owner.
     */
    private function isOwnLeftover(string $target): bool
    {
        if (is_link($target) || !is_dir($target) || $this->host->isActive(Layout::BASENAME)) {
            return false;
        }
        $main = @file_get_contents($target . '/' . Layout::MAIN, false, null, 0, 8192); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
        return is_string($main)
            && strpos($main, 'Plugin Name:       Runova Connector') !== false
            && preg_match('/^ \* Version:\s+' . preg_quote($this->env->pluginVersion(), '/') . '\s*$/m', $main) === 1;
    }

    private function move(string $from, string $to): bool
    {
        return (bool) call_user_func($this->rename, $from, $to);
    }

    /** Removes the dot folders a crashed move left beside the plugin. */
    private function sweep(string $root): void
    {
        $names = @scandir($root); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        foreach (is_array($names) ? $names : array() as $name) {
            if (preg_match('/^\.runova-connector-new-[0-9a-f]{12}$/D', $name) === 1) {
                $this->remove($root . '/' . $name);
            }
        }
    }

    private function remove(string $path): void
    {
        self::removeTree($path);
    }

    /** Deletes a file or folder. Never follows a symlink. */
    private static function removeTree(string $path): void
    {
        if (is_link($path) || is_file($path)) {
            @unlink($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            return;
        }
        if (!is_dir($path)) {
            return;
        }
        $names = @scandir($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        foreach (is_array($names) ? $names : array() as $name) {
            if ($name !== '.' && $name !== '..') {
                self::removeTree($path . '/' . $name);
            }
        }
        @rmdir($path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
    }

    private function refused(string $reason, string $message): ApiError
    {
        return new ApiError('updateRefused', $message, array('reason' => $reason));
    }
}
