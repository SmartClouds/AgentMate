<?php
/**
 * Which paths inside a theme, plugin or mu-plugin may be read or written. Mirrors pathPolicy.ts:
 * the order of the checks is part of the contract, since the shared vectors pin the reason for
 * every case. The hard deny list keeps agent, Runova, secret and VCS files off the site no
 * matter what the client asks for.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

use Runova\Connector\Protocol;
use Runova\Connector\Support\Text;

final class PathPolicy
{
    /** Folders that hold agent settings, skills, Runova's own files, or version control. */
    const DENY_DIRS = array(
        '.runova',
        '.agentmate', // legacy-name
        '.claude',
        '.agents',
        '.codex',
        '.cursor',
        '.windsurf',
        '.continue',
        '.factory',
        '.gemini',
        '.opencode',
        '.roo',
        '.kiro',
        '.amazonq',
        '.junie',
        '.clinerules',
        '.github',
        '.git',
        '.svn',
        '.hg',
        '.worktrees',
    );

    /** Files by exact name (lowercase): agent instructions, MCP config, secrets, PHP config. */
    const DENY_FILES = array(
        'agents.md',
        'claude.md',
        'claude.local.md',
        'gemini.md',
        '.mcp.json',
        'opencode.json',
        '.cursorrules',
        '.windsurfrules',
        '.roomodes',
        '.runovaignore',
        '.agentmateignore', // legacy-name
        '.env',
        '.envrc',
        // Package manager and network credentials.
        '.npmrc',
        'auth.json',
        '.netrc',
        '.git-credentials',
        '.user.ini',
        'php.ini',
        '.ds_store',
        'thumbs.db',
        'desktop.ini',
    );

    const DENY_PREFIXES = array('.aider', '.claude', '.runova', '.agentmate', '.env.', 'id_rsa', 'id_ed25519', 'id_ecdsa'); // legacy-name

    const DENY_SUFFIXES = array('.pem', '.ppk');

    const RESERVED = '/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/D';

    const SLUG = '/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/D';

    /** True when any segment of the path is on the hard deny list (case-insensitive). */
    public static function isHardDenied(string $path): bool
    {
        foreach (explode('/', $path) as $segment) {
            if (self::segmentDenied($segment)) {
                return true;
            }
        }
        return false;
    }

    public static function segmentDenied(string $segment): bool
    {
        // NFKC first, as the desktop does, so lookalikes a case-insensitive disk may fold together
        // (the long s in `.curſor`, fullwidth letters) are judged as the name they become.
        $name = Text::lower(Text::nfkc($segment));
        if (in_array($name, self::DENY_DIRS, true) || in_array($name, self::DENY_FILES, true)) {
            return true;
        }
        foreach (self::DENY_PREFIXES as $prefix) {
            if (strncmp($name, $prefix, strlen($prefix)) === 0) {
                return true;
            }
        }
        foreach (self::DENY_SUFFIXES as $suffix) {
            $length = strlen($suffix);
            if (strlen($name) >= $length && substr($name, -$length) === $suffix) {
                return true;
            }
        }
        return false;
    }

    /**
     * Checks a path relative to an item root. Null when it is fine, otherwise the reason. In order:
     * empty, tooLong, controlChar, backslash, absolute, driveLetter, colon; then for each segment
     * from the left: emptySegment, traversal, segmentTooLong, trailingDotOrSpace, reservedName; and
     * last, hardDenied.
     */
    public static function validate(string $path): ?string
    {
        if ($path === '') {
            return 'empty';
        }
        if (strlen($path) > Protocol::MAX_PATH_BYTES) {
            return 'tooLong';
        }
        if (Text::hasControl($path)) {
            return 'controlChar';
        }
        if (strpos($path, '\\') !== false) {
            return 'backslash';
        }
        if ($path[0] === '/') {
            return 'absolute';
        }
        if (preg_match('/^[A-Za-z]:/', $path) === 1) {
            return 'driveLetter';
        }
        if (strpos($path, ':') !== false) {
            return 'colon';
        }
        foreach (explode('/', $path) as $segment) {
            if ($segment === '') {
                return 'emptySegment';
            }
            if ($segment === '.' || $segment === '..') {
                return 'traversal';
            }
            if (strlen($segment) > Protocol::MAX_SEGMENT_BYTES) {
                return 'segmentTooLong';
            }
            $last = substr($segment, -1);
            if ($last === '.' || $last === ' ') {
                return 'trailingDotOrSpace';
            }
            $dot = strpos($segment, '.');
            $base = Text::lower($dot === false ? $segment : substr($segment, 0, $dot));
            if (preg_match(self::RESERVED, $base) === 1) {
                return 'reservedName';
            }
        }
        if (self::isHardDenied($path)) {
            return 'hardDenied';
        }
        return null;
    }

    /**
     * A theme, plugin or mu-plugin name: a folder name, or a single-file item's `.php` file name.
     *
     * @param mixed $slug
     */
    public static function isValidSlug($slug): bool
    {
        return is_string($slug) && preg_match(self::SLUG, $slug) === 1 && self::validate($slug) === null;
    }

    public static function isFileItemSlug(string $slug): bool
    {
        return self::isValidSlug($slug) && substr(strtolower($slug), -4) === '.php';
    }

    /**
     * @param mixed $kind
     */
    public static function isKind($kind): bool
    {
        return $kind === 'theme' || $kind === 'plugin' || $kind === 'mu-plugin';
    }
}
