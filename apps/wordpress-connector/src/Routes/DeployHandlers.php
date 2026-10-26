<?php
/**
 * The deploy and rescue routes. Scope and kill switches were checked by the dispatcher already.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Http\ApiError;

final class DeployHandlers implements Handler
{
    /** @var DeployService */
    private $service;

    public function __construct(DeployService $service)
    {
        $this->service = $service;
    }

    /** @return string[] */
    public static function routes(): array
    {
        return array(
            '/deploy/begin',
            '/deploy/upload',
            '/deploy/commit',
            '/deploy/verify',
            '/deploy/finalize',
            '/deploy/rollback',
            '/deploy/abort',
            '/deploy/history',
            '/rescue/status',
            '/rescue/rollback',
        );
    }

    /** @return string[] the routes the guard and rescue.php serve */
    public static function rescueRoutes(): array
    {
        return array('/rescue/status', '/rescue/rollback');
    }

    public function handle(RequestContext $context): Result
    {
        $body = $context->body;
        switch ($context->route) {
            case '/deploy/begin':
                return new Result($this->service->begin($body, $context->connection, $context->ip));
            case '/deploy/upload':
                return new Result($this->service->upload($body, $context->frame));
            case '/deploy/commit':
                return new Result($this->service->commit($body));
            case '/deploy/verify':
                return new Result($this->service->verify($body));
            case '/deploy/finalize':
                return new Result($this->service->finalize($body));
            case '/deploy/rollback':
                return new Result($this->service->rollback($body));
            case '/deploy/abort':
                return new Result($this->service->abort($body));
            case '/deploy/history':
                return new Result($this->service->history($body));
            case '/rescue/status':
                return new Result($this->service->rescueStatus());
            case '/rescue/rollback':
                return new Result($this->service->rescueRollback($body));
        }
        throw ApiError::badRequest('That route is not handled here.');
    }
}
