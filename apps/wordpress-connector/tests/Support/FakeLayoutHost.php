<?php
/**
 * LayoutHost with the active plugin lists in memory.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Support;

use Runova\Connector\Update\LayoutHost;

final class FakeLayoutHost implements LayoutHost
{
    /** @var string[] active_plugins */
    public $active = array();

    /** @var array<string, int> active_sitewide_plugins of the one network */
    public $sitewide = array();

    /** @var array{dir: string, at: int}|null */
    public $job = null;

    /** @var int */
    public $swaps = 0;

    /** @var callable|null runs inside swapActive(), to fail it on purpose */
    public $onSwap = null;

    public function isActive(string $basename): bool
    {
        return in_array($basename, $this->active, true) || isset($this->sitewide[$basename]);
    }

    public function swapActive(string $from, string $to): array
    {
        $this->swaps++;
        if ($this->onSwap !== null) {
            call_user_func($this->onSwap);
        }
        $undo = array(array('active' => $this->active, 'sitewide' => $this->sitewide));
        $this->active = array_map(function ($plugin) use ($from, $to) {
            return $plugin === $from ? $to : $plugin;
        }, $this->active);
        if (isset($this->sitewide[$from])) {
            $this->sitewide[$to] = $this->sitewide[$from];
            unset($this->sitewide[$from]);
        }
        return $undo;
    }

    public function restoreActive(array $undo): void
    {
        foreach ($undo as $change) {
            $this->active = $change['active'];
            $this->sitewide = $change['sitewide'];
        }
    }

    public function deactivate(string $basename): void
    {
        $this->active = array_values(array_diff($this->active, array($basename)));
        unset($this->sitewide[$basename]);
    }

    public function rescueUrl(string $mainFile): ?string
    {
        return 'https://example.test/wp-content/plugins/' . basename(dirname($mainFile)) . '/rescue.php';
    }

    public function cleanupJob(): ?array
    {
        return $this->job;
    }

    public function setCleanupJob(?array $job): void
    {
        $this->job = $job;
    }
}
