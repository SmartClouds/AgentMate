<?php
/**
 * Answers routes this build of the connector does not serve yet, after full authentication.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Http\ApiError;

final class NotYetHandler implements Handler
{
    public function handle(RequestContext $context): Result
    {
        throw new ApiError('badRequest', 'This version of Runova Connector does not handle ' . $context->route . ' yet.', array(), 501);
    }
}
