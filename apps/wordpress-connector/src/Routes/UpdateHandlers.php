<?php
/**
 * The connector update and layout move routes. Scope and kill switches were checked by the
 * dispatcher already.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Http\ApiError;
use Runova\Connector\Update\ConnectorUpdater;
use Runova\Connector\Update\LayoutMigration;

final class UpdateHandlers implements Handler
{
    /** @var ConnectorUpdater */
    private $updater;

    /** @var LayoutMigration */
    private $migration;

    public function __construct(ConnectorUpdater $updater, LayoutMigration $migration)
    {
        $this->updater = $updater;
        $this->migration = $migration;
    }

    /** @return string[] */
    public static function routes(): array
    {
        return array('/connector/update', '/connector/migrate');
    }

    public function handle(RequestContext $context): Result
    {
        if ($context->route === '/connector/update') {
            return new Result($this->updater->update($context->body, $context->frame, $context->connection, $context->ip));
        }
        if ($context->route === '/connector/migrate') {
            return new Result($this->migration->migrate($context->connection, $context->ip));
        }
        throw ApiError::badRequest('That route is not handled here.');
    }
}
