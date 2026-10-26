<?php
/**
 * Turns a `{kind, slug}` from a request into a folder or file on disk, refusing anything that is
 * not plainly inside its root: unknown items, symlinked items, and the connector's own files.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Files;

use Runova\Connector\Env\Environment;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Layout;
use Runova\Connector\Legacy;

final class ItemResolver
{
    /** @var Environment */
    private $env;

    public function __construct(Environment $env)
    {
        $this->env = $env;
    }

    /**
     * @param mixed $item
     * @return array{kind: string, slug: string, path: string, real: string, isFile: bool}
     */
    public function resolve($item): array
    {
        if (!is_array($item) || !isset($item['kind'], $item['slug']) || !PathPolicy::isKind($item['kind'])) {
            throw ApiError::badRequest('An item needs a kind (theme, plugin or mu-plugin) and a slug.');
        }
        $kind = $item['kind'];
        $slug = $item['slug'];
        if (!PathPolicy::isValidSlug($slug)) {
            $reason = is_string($slug) ? PathPolicy::validate($slug) : null;
            if ($reason !== null) {
                throw new ApiError('pathRejected', 'That is not a name a theme or plugin can have.', array('path' => $slug, 'reason' => $reason));
            }
            throw ApiError::badRequest('That is not a name a theme or plugin can have.');
        }
        $root = $this->env->itemRoot($kind);
        $rootReal = realpath($root);
        $path = $root . '/' . $slug;
        if (!is_string($rootReal) || (!file_exists($path) && !is_link($path))) {
            throw new ApiError('itemUnknown', 'The site has no such item.', array('kind' => $kind, 'slug' => $slug));
        }
        if (is_link($path)) {
            throw new ApiError('pathRejected', 'That item is a symlink, which is never synced.', array('path' => $slug, 'reason' => 'symlink'));
        }
        $real = Paths::containedReal($path, $rootReal . '/' . $slug);
        if ($real === null) {
            throw new ApiError('pathRejected', 'That item is not plainly inside its folder.', array('path' => $slug, 'reason' => 'symlink'));
        }
        $isFile = is_file($real);
        if ($isFile ? ($kind === 'theme' || !PathPolicy::isFileItemSlug($slug)) : !is_dir($real)) {
            throw new ApiError('itemUnknown', 'The site has no such item.', array('kind' => $kind, 'slug' => $slug));
        }
        if ($this->isProtected($kind, $slug, $real)) {
            throw new ApiError('itemProtected', 'That item belongs to Runova Connector itself and is never synced.', array('kind' => $kind, 'slug' => $slug));
        }
        return array('kind' => $kind, 'slug' => $slug, 'path' => $path, 'real' => $real, 'isFile' => $isFile);
    }

    /** The connector's own folder, its guard, and anything that holds or is inside its data folder. */
    public function isProtected(string $kind, string $slug, ?string $real): bool
    {
        if ($kind === 'plugin' && strcasecmp($slug, $this->env->connectorSlug()) === 0) {
            return true;
        }
        if ($kind === 'mu-plugin' && strcasecmp($slug, $this->env->guardSlug()) === 0) {
            return true;
        }
        // The copy in the other layout and its guard, while a site moves between the two.
        if ($kind === 'plugin' && (strcasecmp($slug, Legacy::SLUG) === 0 || strcasecmp($slug, Layout::SLUG) === 0)) {
            return true;
        }
        if ($kind === 'mu-plugin' && strcasecmp($slug, Legacy::GUARD_FILE) === 0) {
            return true;
        }
        if ($real === null) {
            return false;
        }
        $data = realpath($this->env->dataDir());
        if (!is_string($data)) {
            return false;
        }
        return Paths::same($data, $real) || Paths::inside($data, $real) || Paths::inside($real, $data);
    }
}
