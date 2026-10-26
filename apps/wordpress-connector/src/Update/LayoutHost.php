<?php
/**
 * What LayoutMigration needs from WordPress beyond files: which plugins are active, the plugin
 * list it rewrites, rescue.php's address and the delayed removal of the old folder. The unit
 * tests give it a fake.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Update;

interface LayoutHost
{
    /** Active on the site, or network-active on any network. */
    public function isActive(string $basename): bool;

    /**
     * Replaces $from with $to wherever it is active, by writing the option itself: no activation
     * or deactivation hook runs. Returns what it changed, for restoreActive().
     *
     * @return array<int, array<string, mixed>>
     */
    public function swapActive(string $from, string $to): array;

    /**
     * @param array<int, array<string, mixed>> $undo what swapActive() returned
     */
    public function restoreActive(array $undo): void;

    /** Takes $basename out of the active lists without running its deactivation hook. */
    public function deactivate(string $basename): void;

    /** rescue.php's address for a main file, or null when it is not on the site's own origin. */
    public function rescueUrl(string $mainFile): ?string;

    /**
     * The pending removal of an old folder, or null.
     *
     * @return array{dir: string, at: int}|null
     */
    public function cleanupJob(): ?array;

    /**
     * @param array{dir: string, at: int}|null $job
     */
    public function setCleanupJob(?array $job): void;
}
