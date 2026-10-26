<?php
/**
 * The site's themes, plugins and mu-plugins as WpItem records. Names that cannot be a slug (a
 * folder with a space, a theme in a subfolder) are left out, since they can never be synced.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Info;

use Runova\Connector\Env\Environment;
use Runova\Connector\Files\ItemResolver;
use Runova\Connector\Files\PathPolicy;

final class Items
{
    /** @var Environment */
    private $env;

    /** @var ItemResolver */
    private $resolver;

    public function __construct(Environment $env, ItemResolver $resolver)
    {
        $this->env = $env;
        $this->resolver = $resolver;
    }

    /** Whether this site lets anything be written at all. */
    public static function writesAllowed(Environment $env): bool
    {
        return !$env->constantOn('RUNOVA_CONNECTOR_READ_ONLY')
            && !$env->constantOn('RUNOVA_CONNECTOR_DISABLED')
            && $env->fileModsAllowed()
            && $env->filesystemMethod() === 'direct';
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    public function all(): array
    {
        $writes = self::writesAllowed($this->env);
        return array_merge($this->themes($writes), $this->plugins($writes), $this->muPlugins($writes));
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function themes(bool $writes): array
    {
        $active = $this->env->activeTheme();
        $items = array();
        foreach ($this->env->themes() as $theme) {
            $slug = $theme['slug'];
            if (!PathPolicy::isValidSlug($slug)) {
                continue;
            }
            $item = $this->item('theme', $slug, $theme['name'], $theme['version'], false, $writes);
            $item['active'] = $slug === $active['stylesheet'] || $slug === $active['template'];
            if ($theme['parent'] !== null) {
                $item['parentTheme'] = $theme['parent'];
            }
            $items[$slug] = $item;
        }
        ksort($items, SORT_STRING);
        return array_values($items);
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function plugins(bool $writes): array
    {
        $active = $this->env->activePlugins();
        $network = $this->env->networkActivePlugins();
        $grouped = array();
        foreach ($this->env->plugins() as $file => $headers) {
            $file = (string) $file;
            $slash = strpos($file, '/');
            $slug = $slash === false ? $file : substr($file, 0, $slash);
            if (!PathPolicy::isValidSlug($slug)) {
                continue;
            }
            $isMain = !isset($grouped[$slug]) || $file === $slug . '/' . $slug . '.php';
            if (!isset($grouped[$slug])) {
                $grouped[$slug] = array('files' => array(), 'main' => $file, 'headers' => $headers, 'isFile' => $slash === false);
            }
            if ($isMain) {
                $grouped[$slug]['main'] = $file;
                $grouped[$slug]['headers'] = $headers;
            }
            $grouped[$slug]['files'][] = $file;
        }
        ksort($grouped, SORT_STRING);
        $items = array();
        foreach ($grouped as $slug => $group) {
            $headers = $group['headers'];
            $item = $this->item(
                'plugin',
                (string) $slug,
                isset($headers['Name']) ? (string) $headers['Name'] : '',
                isset($headers['Version']) ? (string) $headers['Version'] : '',
                $group['isFile'],
                $writes
            );
            $item['active'] = count(array_intersect($group['files'], $active)) > 0;
            $item['networkActive'] = count(array_intersect($group['files'], $network)) > 0;
            $item['mainFile'] = $group['main'];
            $items[] = $item;
        }
        return $items;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private function muPlugins(bool $writes): array
    {
        $items = array();
        foreach ($this->env->muPlugins() as $file => $headers) {
            $file = (string) $file;
            if (strpos($file, '/') !== false || !PathPolicy::isFileItemSlug($file)) {
                continue;
            }
            $item = $this->item(
                'mu-plugin',
                $file,
                isset($headers['Name']) ? (string) $headers['Name'] : '',
                isset($headers['Version']) ? (string) $headers['Version'] : '',
                true,
                $writes
            );
            // WordPress loads every top-level mu-plugin file on every request.
            $item['active'] = true;
            $items[$file] = $item;
        }
        $root = $this->env->itemRoot('mu-plugin');
        $names = is_dir($root) ? @scandir($root, SCANDIR_SORT_NONE) : false; // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
        foreach (is_array($names) ? $names : array() as $name) {
            if (!is_string($name) || isset($items[$name]) || !PathPolicy::isValidSlug($name) || !is_dir($root . '/' . $name)) {
                continue;
            }
            $items[$name] = $this->item('mu-plugin', $name, '', '', false, $writes);
        }
        ksort($items, SORT_STRING);
        return array_values($items);
    }

    /**
     * @return array<string, mixed>
     */
    private function item(string $kind, string $slug, string $name, string $version, bool $isFile, bool $writes): array
    {
        $path = $this->env->itemRoot($kind) . '/' . $slug;
        $real = realpath($path);
        $protected = $this->resolver->isProtected($kind, $slug, is_string($real) ? $real : null);
        $writable = $writes && !$protected && !is_link($path) && is_string($real) && is_writable($real);
        return array(
            'kind' => $kind,
            'slug' => $slug,
            'name' => $name !== '' ? $name : $slug,
            'version' => $version,
            'isFile' => $isFile,
            'active' => false,
            'networkActive' => false,
            'writable' => $writable,
            'protected' => $protected,
        );
    }
}
