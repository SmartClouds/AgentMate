<?php
/**
 * What the request handling needs to know about the site, behind one interface so it can be
 * tested without WordPress. WordPressEnvironment is the real one.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Env;

interface Environment
{
    public function now(): int;

    /** Seconds since the request started, with a fraction. */
    public function elapsed(): float;

    public function pluginVersion(): string;

    /** Layout::RUNOVA, or Layout::BRIDGE while the site still runs from the 1.63 folder. */
    public function layout(): string;

    public function siteName(): string;

    public function homeUrl(): string;

    public function siteUrl(): string;

    /** The REST base for the namespace, already in `?rest_route=` form on plain permalinks. */
    public function restUrl(): string;

    public function ajaxUrl(): string;

    public function wpVersion(): string;

    public function isMultisite(): bool;

    /**
     * @return array{stylesheet: string, template: string}
     */
    public function activeTheme(): array;

    public function isHttps(): bool;

    /** True when the constant is defined and truthy. */
    public function constantOn(string $name): bool;

    /** DISALLOW_FILE_MODS, as WordPress itself decides it (filters included). */
    public function fileModsAllowed(): bool;

    public function filesystemMethod(): string;

    public function iniGet(string $name): string;

    public function memoryUsage(): int;

    /** Absolute folder that holds items of a kind, without a trailing slash. */
    public function itemRoot(string $kind): string;

    /**
     * Themes in the default theme root.
     *
     * @return array<int, array{slug: string, name: string, version: string, parent: string|null}>
     */
    public function themes(): array;

    /**
     * get_plugins(): plugin file relative to the plugins folder => headers.
     *
     * @return array<string, array<string, string>>
     */
    public function plugins(): array;

    /**
     * Top-level mu-plugin files => headers.
     *
     * @return array<string, array<string, string>>
     */
    public function muPlugins(): array;

    /**
     * @return string[] plugin files active on the main site (network-active ones included)
     */
    public function activePlugins(): array;

    /**
     * @return string[] network-active plugin files
     */
    public function networkActivePlugins(): array;

    /** The folder this plugin lives in, under the plugins root. */
    public function connectorSlug(): string;

    /** File name of the guard in the mu-plugins folder. */
    public function guardSlug(): string;

    public function dataDir(): string;

    public function rescueUrl(): ?string;

    public function sodiumMode(): string;

    /** Seconds a deploy has to be confirmed after it is applied (180 unless a test shortens it). */
    public function confirmSeconds(): int;

    /**
     * Loopback probes of the site, as WpHealthCheck records (home and ajaxPing).
     *
     * @return array<int, array{name: string, status: int|null, ok: bool|null, detail: string}>
     */
    public function healthChecks(): array;

    /**
     * Fetches a public file over HTTPS, following redirects: the body, or a short reason it could
     * not be had (no HTTP transport, a blocked host, an HTTP error, too large, too slow).
     *
     * @return array{body: string|null, error: string}
     */
    public function download(string $url, int $maxBytes, int $timeoutSeconds): array;

    /** Drops a changed PHP file from the opcode cache. */
    public function invalidateOpcache(string $path): void;

    /** Forgets WordPress's cached theme and plugin lists after files change. */
    public function cleanCaches(): void;

    /**
     * Writes the guard's one autoloaded option: the pending deploy, or null when there is none.
     *
     * @param array{d: string, t: int, f: string[]}|null $state
     */
    public function setGuardState(?array $state): void;

    /** Permissions for new files and folders (FS_CHMOD_FILE, FS_CHMOD_DIR). */
    public function fileMode(): int;

    public function dirMode(): int;
}
