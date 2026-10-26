<?php
/**
 * Route => handler maps, built the same way for the plugin, the guard, rescue.php and the tests.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Env\Environment;
use Runova\Connector\Files\AtomicWriter;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Update\ConnectorUpdater;
use Runova\Connector\Update\LayoutHost;
use Runova\Connector\Update\LayoutMigration;
use Runova\Connector\Update\WpLayoutHost;

final class Handlers
{
    /**
     * Every route the plugin serves.
     *
     * @param callable|null $rename how the connector update and the layout move rename folders; tests make it fail
     * @param LayoutHost|null $host WordPress's side of the layout move; tests pass a fake
     * @return array<string, Handler>
     */
    public static function all(Storage $storage, Environment $env, ?AtomicWriter $writer = null, ?callable $rename = null, ?LayoutHost $host = null): array
    {
        $audit = new AuditLog($storage);
        $read = new ReadHandlers($storage, $env, $audit);
        $service = new DeployService($storage, $env, $audit, $writer);
        $deploy = new DeployHandlers($service);
        $update = new UpdateHandlers(
            new ConnectorUpdater($env, $audit, $service, $rename),
            new LayoutMigration($env, $audit, $service, $host !== null ? $host : new WpLayoutHost(), $rename)
        );
        $map = array();
        foreach (ReadHandlers::routes() as $route) {
            $map[$route] = $read;
        }
        foreach (DeployHandlers::routes() as $route) {
            $map[$route] = $deploy;
        }
        foreach (UpdateHandlers::routes() as $route) {
            $map[$route] = $update;
        }
        return $map;
    }

    /**
     * Only /rescue/status and /rescue/rollback, for the guard and rescue.php.
     *
     * @return array<string, Handler>
     */
    public static function rescue(Storage $storage, Environment $env): array
    {
        $deploy = new DeployHandlers(new DeployService($storage, $env, new AuditLog($storage)));
        $map = array();
        foreach (DeployHandlers::rescueRoutes() as $route) {
            $map[$route] = $deploy;
        }
        return $map;
    }
}
