<?php
/**
 * JSON in and out with the plugin's flags. Works with or without WordPress loaded.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Support;

use Runova\Connector\Protocol;

final class Json
{
    /**
     * @param mixed $value
     */
    public static function encode($value): string
    {
        $text = json_encode($value, Protocol::JSON_FLAGS);
        if (!is_string($text)) {
            throw new \InvalidArgumentException('The value could not be written as JSON.');
        }
        return $text;
    }

    /**
     * Decodes to arrays; null when the text is not JSON.
     *
     * @return mixed
     */
    public static function decode(string $text)
    {
        $value = json_decode($text, true);
        return json_last_error() === JSON_ERROR_NONE ? $value : null;
    }
}
