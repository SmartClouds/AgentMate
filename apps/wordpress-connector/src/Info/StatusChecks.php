<?php
/**
 * The site checks shown on the Status tab and by `wp runova status`: what would stop a deploy
 * or make it less safe here.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Info;

use Runova\Connector\Deploy\SyntaxCheck;
use Runova\Connector\Env\Environment;
use Runova\Connector\Protocol;
use Runova\Connector\Storage\Storage;

final class StatusChecks
{
    /**
     * Each check: id, label, ok (true, false, or null when it is only worth knowing), detail.
     *
     * @param array{headerVersion?: string|null, guardCurrent?: bool|null} $facts things only WordPress can tell
     * @return array<int, array{id: string, label: string, ok: bool|null, detail: string}>
     */
    public static function run(Environment $env, Storage $storage, array $facts = array()): array
    {
        $checks = array();
        $version = $env->pluginVersion();
        $header = isset($facts['headerVersion']) ? $facts['headerVersion'] : null;
        $checks[] = self::check(
            'version',
            'Connector version',
            $header === null || $header === $version,
            $header === null || $header === $version
                ? $version . ', protocol ' . Protocol::VERSION
                : 'The plugin header says ' . $header . ' but the code is ' . $version . '. Upload the plugin zip again.'
        );

        $modsAllowed = $env->fileModsAllowed();
        $checks[] = self::check(
            'fileMods',
            'File changes',
            $modsAllowed,
            $modsAllowed ? 'Allowed.' : 'DISALLOW_FILE_MODS is set in wp-config.php, so nothing can be deployed. Pulling still works.'
        );

        $method = $env->filesystemMethod();
        $checks[] = self::check(
            'filesystem',
            'Direct file access',
            $method === 'direct',
            $method === 'direct' ? 'PHP can write the files itself.' : 'WordPress would use "' . $method . '", so deploys are off. Pulling still works.'
        );

        if ($env->constantOn('RUNOVA_CONNECTOR_DISABLED')) {
            $checks[] = self::check('switches', 'Switches in wp-config.php', false, 'RUNOVA_CONNECTOR_DISABLED is set: the connector answers nothing.');
        } elseif ($env->constantOn('RUNOVA_CONNECTOR_READ_ONLY')) {
            $checks[] = self::check('switches', 'Switches in wp-config.php', null, 'RUNOVA_CONNECTOR_READ_ONLY is set: every key can only read.');
        } else {
            $checks[] = self::check('switches', 'Switches in wp-config.php', true, 'None set.');
        }

        $probes = $env->healthChecks();
        $verdict = null;
        $details = array();
        foreach ($probes as $probe) {
            $details[] = $probe['name'] . ': ' . $probe['detail'];
            if ($probe['ok'] === false) {
                $verdict = false;
            } elseif ($probe['ok'] === true && $verdict === null) {
                $verdict = true;
            }
        }
        $storage->kvSet(SiteInfo::LOOPBACK_KEY, $verdict === null ? 'unknown' : ($verdict ? 'ok' : 'failed'), null);
        $checks[] = self::check(
            'loopback',
            'Loopback health check',
            $verdict,
            ($verdict === null ? 'The site cannot check itself, so a broken deploy is only caught by the guard. ' : '') . implode('; ', $details)
        );

        $guard = $env->itemRoot('mu-plugin') . '/' . $env->guardSlug();
        $installed = is_file($guard);
        $current = isset($facts['guardCurrent']) ? $facts['guardCurrent'] : null;
        $checks[] = self::check(
            'guard',
            'Recovery guard',
            $installed && $current !== false,
            !$installed
                ? 'Not installed: the mu-plugins folder is not writable. Deploys still work, but nothing rolls back a deploy that breaks the site.'
                : ($current === false ? 'Out of date. Visit this page again after updating, or reactivate the plugin.' : 'Installed in mu-plugins.')
        );

        $sodium = $env->sodiumMode();
        $checks[] = self::check('sodium', 'Signatures (Ed25519)', true, $sodium === 'native' ? 'Native (ext-sodium).' : 'WordPress\'s pure-PHP copy. It works, a little slower.');

        $data = $env->dataDir();
        $writable = is_dir($data) ? is_writable($data) : is_writable(dirname($data));
        $checks[] = self::check(
            'dataDir',
            'Private data folder',
            $writable,
            ($writable ? 'Writable: ' : 'Not writable, so nothing can be staged: ') . basename($data)
        );

        $syntax = SyntaxCheck::available();
        $checks[] = self::check(
            'syntax',
            'PHP syntax check',
            $syntax ? true : null,
            $syntax ? 'Every PHP file is checked before it is applied.' : 'ext-tokenizer is missing, so PHP files are applied without a syntax check.'
        );

        $https = $env->isHttps();
        $checks[] = self::check(
            'https',
            'HTTPS',
            $https ? true : null,
            $https ? 'The site uses HTTPS.' : 'The site uses plain HTTP. Runova refuses it unless you allow it for this site.'
        );
        return $checks;
    }

    /**
     * @return array{id: string, label: string, ok: bool|null, detail: string}
     */
    private static function check(string $id, string $label, ?bool $ok, string $detail): array
    {
        return array('id' => $id, 'label' => $label, 'ok' => $ok, 'detail' => $detail);
    }
}
