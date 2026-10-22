<?php
/**
 * The WpSiteInfo record for /site/info.
 *
 * @package AgentMate\Connector
 */

namespace AgentMate\Connector\Info;

use AgentMate\Connector\Env\Environment;
use AgentMate\Connector\Protocol;
use AgentMate\Connector\Storage\Storage;
use AgentMate\Connector\Update\ConnectorUpdater;

final class SiteInfo
{
    /** kv key the health checks write the last loopback result to. */
    const LOOPBACK_KEY = 'loopback';

    /** kv key the deploy service keeps the pending deploy under. */
    const PENDING_KEY = 'pendingDeploy';

    /** @var Environment */
    private $env;

    /** @var Storage */
    private $storage;

    public function __construct(Environment $env, Storage $storage)
    {
        $this->env = $env;
        $this->storage = $storage;
    }

    /**
     * @param array<string, mixed> $connection
     * @return array<string, mixed>
     */
    public function build(array $connection): array
    {
        $env = $this->env;
        $now = $env->now();
        $active = $env->activeTheme();
        $loopback = $this->storage->kvGet(self::LOOPBACK_KEY, $now);
        $guard = $env->itemRoot('mu-plugin') . '/' . $env->guardSlug();
        return array(
            'siteName' => $env->siteName(),
            'homeUrl' => $env->homeUrl(),
            'siteUrl' => $env->siteUrl(),
            'wpVersion' => $env->wpVersion(),
            'phpVersion' => PHP_VERSION,
            'pluginVersion' => $env->pluginVersion(),
            'protocol' => Protocol::VERSION,
            'multisite' => $env->isMultisite(),
            'activeTheme' => array('stylesheet' => $active['stylesheet'], 'template' => $active['template']),
            'https' => $env->isHttps(),
            'serverTime' => $now,
            'fileModsDisabled' => !$env->fileModsAllowed(),
            'fileEditDisabled' => $env->constantOn('DISALLOW_FILE_EDIT'),
            'filesystemMethod' => $env->filesystemMethod(),
            'readOnlyByConstant' => $env->constantOn('AGENTMATE_CONNECTOR_READ_ONLY'),
            'selfUpdate' => ConnectorUpdater::replaceable($env),
            'updateDownload' => true,
            'sodium' => $env->sodiumMode(),
            'limits' => Limits::forEnvironment($env),
            'guard' => array('installed' => is_file($guard), 'rescueUrl' => $env->rescueUrl()),
            'loopback' => in_array($loopback, array('ok', 'failed'), true) ? $loopback : 'unknown',
            'connection' => array(
                'id' => $connection['id'],
                'label' => $connection['label'],
                'scope' => $connection['scope'],
                'createdAt' => $connection['created_at'],
                'expiresAt' => $connection['expires_at'],
            ),
            'pendingDeploy' => $this->pendingDeploy($now),
        );
    }

    /**
     * @return array{deployId: string, state: string, deadline: int}|null
     */
    private function pendingDeploy(int $now): ?array
    {
        $raw = $this->storage->kvGet(self::PENDING_KEY, $now);
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data) || !isset($data['deployId'], $data['state'], $data['deadline'])) {
            return null;
        }
        return array('deployId' => (string) $data['deployId'], 'state' => (string) $data['state'], 'deadline' => (int) $data['deadline']);
    }
}
