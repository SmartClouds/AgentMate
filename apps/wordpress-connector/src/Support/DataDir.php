<?php
/**
 * The plugin's private folder, `wp-content/runova-connector-<random12>/`, for staged files and
 * snapshots. It gets a random name, deny rules for Apache and IIS, and an index.php, and what goes
 * in it has no file extension, so nothing in it can be run from the web even on nginx.
 * RUNOVA_CONNECTOR_DATA_DIR in wp-config.php moves it anywhere (outside the web root is best).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

final class DataDir
{
    const OPTION = 'runova_connector_data_dir';
    const NAME = '/^runova-connector-[0-9a-f]{12}$/D';

    const HTACCESS = "# Runova Connector keeps private files here. Nothing in it is ever served.\n"
        . "<IfModule mod_authz_core.c>\n\tRequire all denied\n</IfModule>\n"
        . "<IfModule !mod_authz_core.c>\n\tOrder deny,allow\n\tDeny from all\n</IfModule>\n";

    const WEB_CONFIG = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        . "<configuration>\n  <system.webServer>\n    <security>\n      <authorization>\n"
        . "        <remove users=\"*\" roles=\"\" verbs=\"\" />\n"
        . "        <add accessType=\"Deny\" users=\"*\" />\n"
        . "      </authorization>\n    </security>\n  </system.webServer>\n</configuration>\n";

    const INDEX = "<?php\n// Silence is golden.\n";

    public static function path(): string
    {
        $chosen = Constants::value('RUNOVA_CONNECTOR_DATA_DIR');
        if (is_string($chosen) && $chosen !== '') {
            return rtrim($chosen, '/\\');
        }
        return WP_CONTENT_DIR . '/' . self::name();
    }

    /** The folder name, picked once and kept in an option. */
    public static function name(): string
    {
        $name = Options::get(self::OPTION);
        if (is_string($name) && preg_match(self::NAME, $name) === 1) {
            return $name;
        }
        Options::add(self::OPTION, 'runova-connector-' . bin2hex(random_bytes(6)));
        $name = Options::get(self::OPTION);
        if (!is_string($name) || preg_match(self::NAME, $name) !== 1) {
            // A bad value was stored by hand; replace it.
            $name = 'runova-connector-' . bin2hex(random_bytes(6));
            Options::update(self::OPTION, $name);
        }
        return $name;
    }

    /** Creates the folder and its guard files when missing. Returns the path. */
    public static function ensure(): string
    {
        $path = self::path();
        if (!is_dir($path) && !wp_mkdir_p($path)) {
            throw new \RuntimeException('The Runova data folder could not be created.');
        }
        self::protect($path);
        return $path;
    }

    public static function protect(string $path): void
    {
        $files = array(
            '.htaccess' => self::HTACCESS,
            'web.config' => self::WEB_CONFIG,
            'index.php' => self::INDEX,
        );
        foreach ($files as $name => $content) {
            $file = $path . '/' . $name;
            if (!file_exists($file)) {
                // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- runs before WP_Filesystem is set up, on our own folder.
                file_put_contents($file, $content);
            }
        }
    }
}
