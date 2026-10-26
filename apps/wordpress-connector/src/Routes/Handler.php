<?php
/**
 * One authenticated route. It runs only after the request's signature, nonce, scope and kill
 * switches have all checked out.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

interface Handler
{
    public function handle(RequestContext $context): Result;
}
