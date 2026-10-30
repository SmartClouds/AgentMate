<?php
/**
 * Removes everything the plugin made: its tables, options and private data folder. Themes and
 * plugins it deployed stay as they are.
 *
 * @package Runova\Connector
 */

if (!defined('WP_UNINSTALL_PLUGIN')) {
    exit;
}

require_once __DIR__ . '/src/Autoloader.php';
\Runova\Connector\Autoloader::register(__DIR__ . '/src');

use Runova\Connector\Activator;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Schema;
use Runova\Connector\Support\Constants;
use Runova\Connector\Support\DataDir;
use Runova\Connector\Support\Options;

global $wpdb;

$runova_data_dir = null;
$runova_name = Options::get(DataDir::OPTION);
if (Constants::value('RUNOVA_CONNECTOR_DATA_DIR') !== null) {
    $runova_data_dir = null; // A folder the owner picked is theirs to remove.
} elseif (is_string($runova_name) && preg_match(DataDir::NAME, $runova_name) === 1) {
    $runova_data_dir = WP_CONTENT_DIR . '/' . $runova_name;
}

foreach (Schema::TABLES as $runova_table) {
    // phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL.NotPrepared -- fixed table names from Schema, no input.
    $wpdb->query('DROP TABLE IF EXISTS ' . Schema::table($wpdb->base_prefix, $runova_table));
}

foreach (array(SiteKeys::OPTION, DataDir::OPTION, Activator::DB_VERSION_OPTION) as $runova_option) {
    Options::delete($runova_option);
}
\Runova\Connector\Guard\GuardInstaller::uninstall();
\Runova\Connector\Guard\GuardState::delete();
@unlink(__DIR__ . '/' . \Runova\Connector\Guard\Rescue::CONFIG); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged

if ($runova_data_dir !== null && is_dir($runova_data_dir) && !is_link($runova_data_dir)) {
    $runova_files = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($runova_data_dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ($runova_files as $runova_file) {
        $runova_path = $runova_file->getPathname();
        if ($runova_file->isDir() && !$runova_file->isLink()) {
            @rmdir($runova_path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
        } else {
            @unlink($runova_path); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        }
    }
    @rmdir($runova_data_dir); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
}
