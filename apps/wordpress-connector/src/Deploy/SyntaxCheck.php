<?php
/**
 * A PHP syntax check with the site's own PHP, before anything is applied. Syntax errors can never
 * be forced past. Without ext-tokenizer there is no check, which /site/info does not hide: the
 * health checks and the guard still stand behind every deploy.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Deploy;

final class SyntaxCheck
{
    public static function available(): bool
    {
        return function_exists('token_get_all') && defined('TOKEN_PARSE');
    }

    /** True for paths PHP would run. */
    public static function isPhp(string $path): bool
    {
        return preg_match('/\.(php|phtml)$/i', $path) === 1;
    }

    /**
     * Null when the code parses, otherwise the first error.
     *
     * @return array{line: int, message: string}|null
     */
    public static function check(string $code): ?array
    {
        if (!self::available()) {
            return null;
        }
        try {
            token_get_all($code, TOKEN_PARSE);
            return null;
        } catch (\CompileError $error) {
            return array('line' => (int) $error->getLine(), 'message' => $error->getMessage());
        }
    }
}
