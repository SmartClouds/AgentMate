<?php
/**
 * The connector update route. Scope and kill switches were checked by the dispatcher already.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Http\ApiError;
use Runova\Connector\Update\ConnectorUpdater;

final class UpdateHandlers implements Handler
{
    /** @var ConnectorUpdater */
    private $updater;

    public function __construct(ConnectorUpdater $updater)
    {
        $this->updater = $updater;
    }

    /** @return string[] */
    public static function routes(): array
    {
        return array('/connector/update');
    }

    public function handle(RequestContext $context): Result
    {
        if ($context->route === '/connector/update') {
            return new Result($this->updater->update($context->body, $context->frame, $context->connection, $context->ip));
        }
        throw ApiError::badRequest('That route is not handled here.');
    }
}
