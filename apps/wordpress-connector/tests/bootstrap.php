<?php
/**
 * Unit tests run without WordPress: the plugin's own autoloader for src/, Composer for the rest.
 *
 * @package Runova\Connector
 */

require_once __DIR__ . '/../vendor/autoload.php';
require_once __DIR__ . '/../src/Autoloader.php';
\Runova\Connector\Autoloader::register(__DIR__ . '/../src');

$vectors = getenv('RUNOVA_WP_VECTORS');
define(
    'RUNOVA_TEST_VECTORS',
    is_string($vectors) && $vectors !== '' ? $vectors : dirname(__DIR__, 3) . '/packages/core/src/deploy/wordpress/vectors'
);
define('RUNOVA_TEST_PROTOCOL_TS', dirname(__DIR__, 3) . '/packages/core/src/deploy/wordpress/protocol.ts');
