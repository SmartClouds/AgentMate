<?php
/**
 * An Environment over a temporary wp-content folder, with every WordPress answer settable.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

use Runova\Connector\Env\Environment;

final class FakeEnvironment implements Environment
{
    /** @var int */
    public $now = 1790000000;

    /** @var float */
    public $elapsed = 0.0;

    /** @var float added to elapsed each time it is read, to fake slow work */
    public $elapsedStep = 0.0;

    /** @var string */
    public $content;

    /** @var array<string, bool> */
    public $constants = array();

    /** @var bool */
    public $fileModsAllowed = true;

    /** @var string */
    public $filesystemMethod = 'direct';

    /** @var array<string, string> */
    public $ini = array(
        'post_max_size' => '8M',
        'upload_max_filesize' => '2M',
        'memory_limit' => '256M',
        'max_execution_time' => '30',
    );

    /** @var array<int, array{slug: string, name: string, version: string, parent: string|null}> */
    public $themes = array();

    /** @var array<string, array<string, string>> */
    public $plugins = array();

    /** @var array<string, array<string, string>> */
    public $muPlugins = array();

    /** @var string[] */
    public $activePlugins = array();

    /** @var string[] */
    public $networkActivePlugins = array();

    /** @var array{stylesheet: string, template: string} */
    public $activeTheme = array('stylesheet' => 'twentytwentyfive', 'template' => 'twentytwentyfive');

    /** @var bool */
    public $multisite = false;

    /** @var string */
    public $dataDir;

    public function __construct(string $content)
    {
        $this->content = rtrim($content, '/');
        foreach (array('themes', 'plugins', 'mu-plugins') as $folder) {
            if (!is_dir($this->content . '/' . $folder)) {
                mkdir($this->content . '/' . $folder, 0777, true);
            }
        }
        $this->dataDir = $this->content . '/runova-connector-0123456789ab';
        if (!is_dir($this->dataDir)) {
            mkdir($this->dataDir, 0777, true);
        }
    }

    public function now(): int
    {
        return $this->now;
    }

    public function elapsed(): float
    {
        $value = $this->elapsed;
        $this->elapsed += $this->elapsedStep;
        return $value;
    }

    /** @var string the version the fake connector reports it runs */
    public $pluginVersion = '1.0.0';

    public function pluginVersion(): string
    {
        return $this->pluginVersion;
    }

    public function siteName(): string
    {
        return 'Test Site';
    }

    public function homeUrl(): string
    {
        return 'https://example.test';
    }

    public function siteUrl(): string
    {
        return 'https://example.test';
    }

    public function restUrl(): string
    {
        return 'https://example.test/wp-json/runova/v1';
    }

    public function ajaxUrl(): string
    {
        return 'https://example.test/wp-admin/admin-ajax.php';
    }

    public function wpVersion(): string
    {
        return '6.8';
    }

    public function isMultisite(): bool
    {
        return $this->multisite;
    }

    public function activeTheme(): array
    {
        return $this->activeTheme;
    }

    public function isHttps(): bool
    {
        return true;
    }

    public function constantOn(string $name): bool
    {
        return !empty($this->constants[$name]);
    }

    public function fileModsAllowed(): bool
    {
        return $this->fileModsAllowed;
    }

    public function filesystemMethod(): string
    {
        return $this->filesystemMethod;
    }

    public function iniGet(string $name): string
    {
        return isset($this->ini[$name]) ? $this->ini[$name] : '';
    }

    public function memoryUsage(): int
    {
        return 20 * 1048576;
    }

    public function itemRoot(string $kind): string
    {
        $folder = $kind === 'theme' ? 'themes' : ($kind === 'plugin' ? 'plugins' : 'mu-plugins');
        return $this->content . '/' . $folder;
    }

    public function themes(): array
    {
        return $this->themes;
    }

    public function plugins(): array
    {
        return $this->plugins;
    }

    public function muPlugins(): array
    {
        return $this->muPlugins;
    }

    public function activePlugins(): array
    {
        return $this->activePlugins;
    }

    public function networkActivePlugins(): array
    {
        return $this->networkActivePlugins;
    }

    /** @var string the plugin folder */
    public $connectorSlug = 'runova-connector';

    public function connectorSlug(): string
    {
        return $this->connectorSlug;
    }

    public function guardSlug(): string
    {
        return '00-runova-connector-guard.php';
    }

    public function dataDir(): string
    {
        return $this->dataDir;
    }

    public function rescueUrl(): ?string
    {
        return null;
    }

    public function sodiumMode(): string
    {
        return 'native';
    }

    /** @var int */
    public $confirmSeconds = 180;

    /** @var array<int, array<int, array{name: string, status: int|null, ok: bool|null, detail: string}>> answers in order; the last one repeats */
    public $health = array();

    /** @var int */
    public $healthCalls = 0;

    /** @var callable|null runs before each health check answer, like a loopback request would */
    public $onHealthCheck = null;

    /** @var string[] */
    public $invalidated = array();

    /** @var int */
    public $cacheCleans = 0;

    /** @var array<int, array{d: string, t: int, f: string[]}|null> */
    public $guardStates = array();

    public function confirmSeconds(): int
    {
        return $this->confirmSeconds;
    }

    public function healthChecks(): array
    {
        $this->healthCalls++;
        if ($this->onHealthCheck !== null) {
            call_user_func($this->onHealthCheck);
        }
        if (count($this->health) === 0) {
            return array(
                array('name' => 'home', 'status' => 200, 'ok' => true, 'detail' => 'HTTP 200'),
                array('name' => 'ajaxPing', 'status' => 200, 'ok' => true, 'detail' => 'HTTP 200'),
            );
        }
        return count($this->health) > 1 ? array_shift($this->health) : $this->health[0];
    }

    /** @var array<string, string> what download() returns by URL; any other URL fails */
    public $downloads = array();

    /** @var array<int, array{url: string, maxBytes: int, timeout: int}> */
    public $downloadCalls = array();

    public function download(string $url, int $maxBytes, int $timeoutSeconds): array
    {
        $this->downloadCalls[] = array('url' => $url, 'maxBytes' => $maxBytes, 'timeout' => $timeoutSeconds);
        if (!isset($this->downloads[$url])) {
            return array('body' => null, 'error' => 'cURL error 6: Could not resolve host: github.com');
        }
        return array('body' => $this->downloads[$url], 'error' => '');
    }

    public function invalidateOpcache(string $path): void
    {
        $this->invalidated[] = $path;
    }

    public function cleanCaches(): void
    {
        $this->cacheCleans++;
    }

    public function setGuardState(?array $state): void
    {
        $this->guardStates[] = $state;
    }

    /** The last state written, or null. */
    public function guardState(): ?array
    {
        return count($this->guardStates) > 0 ? end($this->guardStates) : null;
    }

    public function fileMode(): int
    {
        return 0644;
    }

    public function dirMode(): int
    {
        return 0755;
    }

    /** Writes a file under wp-content, making folders on the way. */
    public function put(string $relative, string $content): string
    {
        $path = $this->content . '/' . $relative;
        if (!is_dir(dirname($path))) {
            mkdir(dirname($path), 0777, true);
        }
        file_put_contents($path, $content);
        return $path;
    }
}
