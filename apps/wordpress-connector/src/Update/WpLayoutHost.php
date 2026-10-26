<?php
/**
 * LayoutHost on a real site. The plugin lists are written as plain options, on every network of
 * a multisite install, because activate_plugin() and deactivate_plugins() would run hooks: the
 * old copy's deactivation hook takes the guard away, and its activation hook was never meant to
 * run twice.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Update;

use Runova\Connector\Env\WordPressEnvironment;
use Runova\Connector\Support\Options;

final class WpLayoutHost implements LayoutHost
{
    public function isActive(string $basename): bool
    {
        $active = get_option('active_plugins', array());
        if (is_array($active) && in_array($basename, $active, true)) {
            return true;
        }
        foreach ($this->networks() as $network) {
            $sitewide = get_network_option($network, 'active_sitewide_plugins', array());
            if (is_array($sitewide) && isset($sitewide[$basename])) {
                return true;
            }
        }
        return false;
    }

    public function swapActive(string $from, string $to): array
    {
        $undo = array();
        $active = get_option('active_plugins', array());
        if (is_array($active) && in_array($from, $active, true)) {
            $undo[] = array('network' => null, 'value' => $active);
            $next = array_values(array_unique(array_map(function ($plugin) use ($from, $to) {
                return $plugin === $from ? $to : $plugin;
            }, $active)));
            sort($next);
            update_option('active_plugins', $next);
        }
        foreach ($this->networks() as $network) {
            $sitewide = get_network_option($network, 'active_sitewide_plugins', array());
            if (!is_array($sitewide) || !isset($sitewide[$from])) {
                continue;
            }
            $undo[] = array('network' => $network, 'value' => $sitewide);
            $next = $sitewide;
            $next[$to] = $sitewide[$from];
            unset($next[$from]);
            update_network_option($network, 'active_sitewide_plugins', $next);
        }
        return $undo;
    }

    public function restoreActive(array $undo): void
    {
        foreach ($undo as $change) {
            if ($change['network'] === null) {
                update_option('active_plugins', $change['value']);
            } else {
                update_network_option((int) $change['network'], 'active_sitewide_plugins', $change['value']);
            }
        }
    }

    public function deactivate(string $basename): void
    {
        $active = get_option('active_plugins', array());
        if (is_array($active) && in_array($basename, $active, true)) {
            update_option('active_plugins', array_values(array_diff($active, array($basename))));
        }
        foreach ($this->networks() as $network) {
            $sitewide = get_network_option($network, 'active_sitewide_plugins', array());
            if (is_array($sitewide) && isset($sitewide[$basename])) {
                unset($sitewide[$basename]);
                update_network_option($network, 'active_sitewide_plugins', $sitewide);
            }
        }
    }

    public function rescueUrl(string $mainFile): ?string
    {
        return (new WordPressEnvironment())->rescueUrlFor($mainFile);
    }

    public function cleanupJob(): ?array
    {
        $job = Options::get(LayoutMigration::CLEANUP_OPTION);
        if (!is_array($job) || !isset($job['dir'], $job['at']) || !is_string($job['dir']) || !is_int($job['at'])) {
            return null;
        }
        return array('dir' => $job['dir'], 'at' => $job['at']);
    }

    public function setCleanupJob(?array $job): void
    {
        if ($job === null) {
            Options::delete(LayoutMigration::CLEANUP_OPTION);
            wp_clear_scheduled_hook(LayoutMigration::CRON_HOOK);
            return;
        }
        Options::update(LayoutMigration::CLEANUP_OPTION, $job);
        // WP-Cron runs it on a visit after the grace period; wp-admin and the app's next call
        // check as well, so a site with cron turned off still gets there.
        wp_clear_scheduled_hook(LayoutMigration::CRON_HOOK);
        wp_schedule_single_event($job['at'] + 1, LayoutMigration::CRON_HOOK);
    }

    /** @return int[] every network's id; none on a single site. */
    private function networks(): array
    {
        if (!is_multisite()) {
            return array();
        }
        $ids = function_exists('get_networks') ? get_networks(array('fields' => 'ids', 'number' => 100)) : array();
        $ids = is_array($ids) ? array_map('intval', $ids) : array();
        return count($ids) > 0 ? $ids : array((int) get_current_network_id());
    }
}
