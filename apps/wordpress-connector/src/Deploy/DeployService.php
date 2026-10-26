<?php
/**
 * The deploy transaction: begin, upload, commit (validate, snapshot, apply), verify, finalize,
 * rollback and abort, plus history and the rescue routes. See StateMachine for the state table.
 *
 * Safety rules, in the order they bite:
 * - begin refuses bad paths, symlinks, protected or unwritable items and (unless forced) conflicts
 *   and deletes of an active plugin's main file or the active theme's style.css or index.php;
 * - commit checks all of that again, plus every upload's hash and PHP syntax (never forceable);
 * - apply runs in two strict phases: every touched file is copied into the snapshot store first,
 *   then files are replaced by temp-and-rename. Both phases are resumable and safe to repeat;
 * - once applied, the deploy must be confirmed (verify heartbeats, then finalize) before its
 *   deadline, or the guard rolls it back.
 *
 * One deploy at a time per site (the lock), and one call at a time per site (the mutex).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Deploy;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Env\Environment;
use Runova\Connector\Files\AtomicWriter;
use Runova\Connector\Files\ItemResolver;
use Runova\Connector\Files\Manifest;
use Runova\Connector\Files\PathPolicy;
use Runova\Connector\Files\Paths;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Info\Limits;
use Runova\Connector\Info\SiteInfo;
use Runova\Connector\Protocol;
use Runova\Connector\Storage\Storage;
use Runova\Connector\Support\Json;
use Runova\Connector\Support\Text;

final class DeployService
{
    const IDLE_SECONDS = 1800;
    const MAX_CONFIRM_SECONDS = 900;
    const KEEP_SNAPSHOTS = 5;
    const KEEP_HISTORY = 20;
    const LOCK = 'deployLock';
    const MUTEX = 'deployMutex';
    const MUTEX_SECONDS = 120;
    const PERSIST_SECONDS = 2.0;
    const MAX_ITEMS = 100;
    const MAX_OPS = 50000;
    const ID = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/D';
    const SHA = '/^[0-9a-f]{64}$/D';

    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var AuditLog */
    private $audit;

    /** @var Staging */
    private $staging;

    /** @var AtomicWriter */
    private $writer;

    /** @var ItemResolver */
    private $resolver;

    /** @var string|null the mutex token while this process holds it */
    private $mutex = null;

    public function __construct(Storage $storage, Environment $env, AuditLog $audit, ?AtomicWriter $writer = null)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->audit = $audit;
        $this->staging = new Staging($env->dataDir());
        $this->writer = $writer !== null ? $writer : new AtomicWriter();
        $this->resolver = new ItemResolver($env);
    }

    // Routes ---------------------------------------------------------------------------------

    /**
     * @param mixed $body
     * @param array<string, mixed> $connection
     * @return array<string, mixed> WpDeployBeginResponse
     */
    public function begin($body, array $connection, string $ip): array
    {
        $body = is_array($body) ? $body : array();
        $label = isset($body['label']) && is_string($body['label']) ? Text::jsTrim($body['label']) : null;
        if ($label === null || Text::hasControl($label) || Text::codePoints($label) > 200) {
            throw ApiError::badRequest('A deploy label is text of up to 200 characters.');
        }
        $items = isset($body['items']) ? $body['items'] : null;
        $ops = isset($body['ops']) ? $body['ops'] : null;
        if (!self::isList($items) || count($items) < 1 || count($items) > self::MAX_ITEMS) {
            throw ApiError::badRequest('A deploy names 1 to 100 items.');
        }
        if (!self::isList($ops) || count($ops) < 1 || count($ops) > self::MAX_OPS) {
            throw ApiError::badRequest('A deploy has at least one file change.');
        }
        $force = isset($body['force']) && $body['force'] === true;

        return $this->locked(function () use ($label, $items, $ops, $force, $connection, $ip) {
            $holder = $this->holder();
            if ($holder !== null) {
                throw new ApiError('busy', 'Another deploy is still open on this site.', array('deployId' => $holder['id']));
            }
            $plan = $this->inspect($items, $ops);
            $limits = Limits::forEnvironment($this->env);
            $hard = array_filter($plan['refusals'], function ($refusal) {
                return !$refusal['forceable'];
            });
            $soft = count($plan['refusals']) - count($hard);
            if (count($hard) > 0 || (!$force && (count($plan['conflicts']) > 0 || $soft > 0))) {
                return array('deployId' => null, 'limits' => $limits, 'baseline' => array(), 'conflicts' => $plan['conflicts'], 'refusals' => $plan['refusals']);
            }
            $id = Crypto::uuid4();
            if (!$this->acquireLock($id)) {
                $holder = $this->holder();
                throw new ApiError('busy', 'Another deploy is still open on this site.', array('deployId' => $holder !== null ? $holder['id'] : null));
            }
            $now = $this->env->now();
            $baseline = $this->env->healthChecks();
            $this->rememberLoopback($baseline);
            $puts = 0;
            foreach ($plan['ops'] as $op) {
                $puts += $op['op'] === 'put' ? 1 : 0;
            }
            $data = array(
                'items' => $plan['rawItems'],
                'rawOps' => $plan['rawOps'],
                'ops' => $plan['ops'],
                'force' => $force,
                'baseline' => $baseline,
                'journal' => array('phase' => 'snapshot', 'next' => 0),
                'snapshots' => array(),
                'createdDirs' => array(),
                'applied' => array(),
                'appliedAt' => null,
                'maxDeadline' => null,
                'lastActivity' => $now,
                'snapshotKept' => false,
            );
            $this->storage->insertDeploy(array(
                'id' => $id,
                'connection_id' => $connection['id'],
                'connection_label' => $connection['label'],
                'label' => $label,
                'state' => 'open',
                'reason' => null,
                'started_at' => $now,
                'updated_at' => $now,
                'finished_at' => null,
                'deadline' => null,
                'puts' => $puts,
                'deletes' => count($plan['ops']) - $puts,
                'data' => Json::encode($data),
            ));
            $this->setPending($id, 'open', $now + self::IDLE_SECONDS);
            $this->audit->add('deployStarted', $now, $ip, 'Started "' . $label . '": ' . $puts . ' files to write, ' . (count($plan['ops']) - $puts) . ' to delete.', $connection);
            return array('deployId' => $id, 'limits' => $limits, 'baseline' => $baseline, 'conflicts' => $plan['conflicts'], 'refusals' => $plan['refusals']);
        });
    }

    /**
     * @param mixed $body
     * @param \Runova\Connector\Http\Frame $frame
     * @return array<string, mixed> WpDeployUploadResponse
     */
    public function upload($body, $frame): array
    {
        $id = self::deployId($body);
        $chunks = is_array($body) && isset($body['chunks']) ? $body['chunks'] : null;
        if (!self::isList($chunks) || count($chunks) !== $frame->blobCount()) {
            throw ApiError::badRequest('Send one blob per chunk.');
        }
        return $this->locked(function () use ($id, $chunks, $frame) {
            $deploy = $this->refresh($this->load($id));
            $this->expect('upload', $deploy);
            $ops = $deploy['data']['ops'];
            $received = array();
            foreach ($chunks as $index => $chunk) {
                $opIndex = is_array($chunk) && isset($chunk['op']) && is_int($chunk['op']) ? $chunk['op'] : -1;
                $offset = is_array($chunk) && isset($chunk['offset']) && is_int($chunk['offset']) ? $chunk['offset'] : -1;
                $final = is_array($chunk) && isset($chunk['final']) && $chunk['final'] === true;
                if ($opIndex < 0 || !isset($ops[$opIndex]) || $ops[$opIndex]['op'] !== 'put' || $offset < 0) {
                    throw ApiError::badRequest('A chunk names an op that is not a put, or a bad offset.');
                }
                $op = $ops[$opIndex];
                if ($this->staging->has($op['sha256'], $op['size'])) {
                    $received[$opIndex] = $op['size'];
                    continue;
                }
                $next = $this->staging->partSize($id, $opIndex);
                $bytes = $frame->blob($index);
                if ($offset > $next) {
                    throw ApiError::badRequest('Chunks of one file must arrive in order.', array('op' => $opIndex, 'nextOffset' => $next));
                }
                if ($offset + strlen($bytes) > $op['size']) {
                    throw ApiError::badRequest('A chunk runs past the size the file was given.', array('op' => $opIndex));
                }
                if ($offset + strlen($bytes) > $next) {
                    $this->staging->append($id, $opIndex, (string) substr($bytes, $next - $offset));
                    $next = $offset + strlen($bytes);
                }
                if ($final) {
                    if ($next !== $op['size']) {
                        throw ApiError::badRequest('The last chunk of a file came before the rest of it.', array('op' => $opIndex, 'nextOffset' => $next));
                    }
                    if (!$this->staging->finish($id, $opIndex, $op['sha256'], $op['size'])) {
                        throw ApiError::badRequest('A file did not match its sha256. Send it again from the start.', array('op' => $opIndex, 'nextOffset' => 0));
                    }
                }
                $received[$opIndex] = $next;
            }
            $deploy['data']['lastActivity'] = $this->env->now();
            $this->save($deploy, 'open');
            $this->setPending($id, 'open', $this->env->now() + self::IDLE_SECONDS);
            $out = array();
            foreach ($received as $opIndex => $next) {
                $out[] = array('op' => $opIndex, 'nextOffset' => $next);
            }
            return array('received' => $out);
        });
    }

    /**
     * @param mixed $body
     * @return array<string, mixed> WpDeployCommitResponse
     */
    public function commit($body): array
    {
        $id = self::deployId($body);
        $force = is_array($body) && isset($body['force']) && $body['force'] === true;
        return $this->locked(function () use ($id, $force) {
            $deploy = $this->refresh($this->load($id));
            $total = count($deploy['data']['ops']);
            if (StateMachine::decide('commit', $deploy['state']) === 'same') {
                $done = in_array($deploy['state'], array('applied', 'done'), true) ? $total : 0;
                return array('state' => $deploy['state'], 'progress' => array('done' => $done, 'total' => $total));
            }
            if ($deploy['state'] === 'open') {
                $force = $force || !empty($deploy['data']['force']);
                $problems = $this->validateForCommit($deploy, $force);
                if ($problems !== null) {
                    $deploy['data']['lastActivity'] = $this->env->now();
                    $this->save($deploy, 'open');
                    return array('state' => 'open', 'progress' => array('done' => 0, 'total' => $total)) + $problems;
                }
                $deploy['data']['force'] = $force;
                $deploy['data']['journal'] = array('phase' => 'snapshot', 'next' => 0);
                $deploy['state'] = 'applying';
                $deploy['deadline'] = $this->env->now() + $this->env->confirmSeconds();
                if (!$this->save($deploy, 'open')) {
                    return $this->commitAnswer($this->load($id));
                }
                $this->publishPending($deploy);
            }
            return $this->run($deploy);
        });
    }

    /**
     * @param mixed $body
     * @return array<string, mixed> WpDeployVerifyResponse
     */
    public function verify($body): array
    {
        $id = self::deployId($body);
        $deploy = $this->locked(function () use ($id) {
            $deploy = $this->refresh($this->load($id));
            $this->expect('verify', $deploy);
            if ($deploy['state'] !== 'applied') {
                return $deploy;
            }
            // A verify is a heartbeat: the deadline moves on, up to 15 minutes after the apply.
            $deploy['deadline'] = min($this->env->now() + $this->env->confirmSeconds(), (int) $deploy['data']['maxDeadline']);
            $deploy['data']['lastActivity'] = $this->env->now();
            $this->save($deploy, 'applied');
            $this->publishPending($deploy);
            return $deploy;
        });
        if ($deploy['state'] !== 'applied') {
            return array('state' => $deploy['state'], 'healthy' => null, 'checks' => array());
        }
        // Outside the mutex: a fatal in a loopback request is rolled back by the guard over there.
        $checks = $this->env->healthChecks();
        $this->rememberLoopback($checks);
        return $this->locked(function () use ($id, $checks) {
            $deploy = $this->load($id);
            if ($deploy['state'] !== 'applied') {
                return array('state' => $deploy['state'], 'healthy' => false, 'checks' => $checks);
            }
            $verdict = self::health((array) $deploy['data']['baseline'], $checks);
            if ($verdict === false) {
                $this->rollbackApplied($deploy, 'healthCheck');
                return array('state' => 'rolledBack', 'healthy' => false, 'checks' => $checks);
            }
            return array('state' => 'applied', 'healthy' => $verdict, 'checks' => $checks);
        });
    }

    /**
     * @param mixed $body
     * @return array<string, mixed> WpDeployStateResponse
     */
    public function finalize($body): array
    {
        $id = self::deployId($body);
        return $this->locked(function () use ($id) {
            $deploy = $this->refresh($this->load($id));
            $this->expect('finalize', $deploy);
            if ($deploy['state'] === 'applied') {
                $this->finish($deploy, 'done', null, 'applied');
            }
            return array('state' => 'done');
        });
    }

    /**
     * @param mixed $body
     * @return array<string, mixed> WpDeployRollbackResponse
     */
    public function rollback($body): array
    {
        $id = self::deployId($body);
        $force = is_array($body) && isset($body['force']) && $body['force'] === true;
        return $this->locked(function () use ($id, $force) {
            $deploy = $this->refresh($this->load($id));
            if (StateMachine::decide('rollback', $deploy['state']) === 'same') {
                return self::stateAnswer($deploy) + array('restored' => 0, 'removed' => 0);
            }
            if ($deploy['state'] === 'open') {
                $this->finish($deploy, 'aborted', null, 'open');
                return array('state' => 'aborted', 'restored' => 0, 'removed' => 0);
            }
            if ($deploy['state'] === 'done') {
                return $this->rollbackDone($deploy, $force);
            }
            return $this->rollbackApplied($deploy, 'requested');
        });
    }

    /**
     * @param mixed $body
     * @return array<string, mixed> WpDeployStateResponse
     */
    public function abort($body): array
    {
        $id = self::deployId($body);
        return $this->locked(function () use ($id) {
            $deploy = $this->refresh($this->load($id));
            $this->expect('abort', $deploy);
            if ($deploy['state'] === 'open') {
                $this->finish($deploy, 'aborted', null, 'open');
                return array('state' => 'aborted');
            }
            if ($deploy['state'] === 'applying' || $deploy['state'] === 'applied') {
                $result = $this->rollbackApplied($deploy, 'requested');
                return array('state' => $result['state'], 'reason' => $result['reason']);
            }
            return self::stateAnswer($deploy);
        });
    }

    /**
     * @param mixed $body
     * @return array{deploys: array<int, array<string, mixed>>}
     */
    public function history($body): array
    {
        $limit = is_array($body) && isset($body['limit']) ? $body['limit'] : 20;
        if (!is_int($limit) || $limit < 1) {
            throw ApiError::badRequest('limit is a whole number from 1.');
        }
        $this->checkPending();
        $out = array();
        foreach ($this->storage->listDeploys(min($limit, 50)) as $row) {
            $out[] = $this->record($this->decode($row));
        }
        return array('deploys' => $out);
    }

    /**
     * @return array{pending: array<string, mixed>|null, last: array<string, mixed>|null}
     */
    public function rescueStatus(): array
    {
        $this->checkPending();
        $last = null;
        foreach ($this->storage->listDeploys(10) as $row) {
            if (!StateMachine::isActive($row['state'])) {
                $last = $this->record($this->decode($row));
                break;
            }
        }
        return array('pending' => $this->pending(), 'last' => $last);
    }

    /**
     * Rolls back the pending deploy (the one route a broken site still needs).
     *
     * @param mixed $body
     * @return array<string, mixed> WpDeployStateResponse
     */
    public function rescueRollback($body): array
    {
        $id = self::deployId($body);
        return $this->locked(function () use ($id) {
            $deploy = $this->refresh($this->load($id));
            if ($deploy['state'] === 'open') {
                $this->finish($deploy, 'aborted', null, 'open');
                return array('state' => 'aborted');
            }
            if ($deploy['state'] === 'applying' || $deploy['state'] === 'applied') {
                $result = $this->rollbackApplied($deploy, 'requested');
                return array('state' => $result['state'], 'reason' => $result['reason']);
            }
            if ($deploy['state'] === 'done') {
                throw new ApiError('invalidState', 'That deploy is finished; roll it back with /deploy/rollback.', array('state' => 'done'));
            }
            return self::stateAnswer($deploy);
        });
    }

    // Guard entry points ---------------------------------------------------------------------

    /** Applies idle expiry and deadlines to the pending deploy, if there is one. */
    public function checkPending(): void
    {
        $this->tryLocked(function () {
            $this->holder();
        });
    }

    /**
     * Called by the guard when PHP died of a fatal error in $file. Rolls the pending deploy back
     * when that file is one it changed.
     */
    public function onFatal(string $file): bool
    {
        $rolledBack = false;
        $this->tryLocked(function () use ($file, &$rolledBack) {
            $id = $this->storage->kvGet(self::LOCK, $this->env->now());
            $deploy = $id !== null ? $this->storage->getDeploy($id) : null;
            if ($deploy === null) {
                return;
            }
            $deploy = $this->decode($deploy);
            if ($deploy['state'] !== 'applying' && $deploy['state'] !== 'applied') {
                return;
            }
            $real = realpath($file);
            foreach ($this->phpTargets($deploy) as $target) {
                if (Paths::same($target, $file) || ($real !== false && Paths::same($target, $real))) {
                    $this->rollbackApplied($deploy, 'fatalError');
                    $rolledBack = true;
                    return;
                }
            }
        });
        return $rolledBack;
    }

    /**
     * The pending deploy for /site/info and /rescue/status.
     *
     * @return array{deployId: string, state: string, deadline: int}|null
     */
    public function pending(): ?array
    {
        $holder = $this->holder();
        if ($holder === null) {
            return null;
        }
        $deadline = $holder['state'] === 'open'
            ? (int) $holder['data']['lastActivity'] + self::IDLE_SECONDS
            : (int) $holder['deadline'];
        return array('deployId' => $holder['id'], 'state' => $holder['state'], 'deadline' => $deadline);
    }

    // Validation -----------------------------------------------------------------------------

    /**
     * Resolves items and ops and finds conflicts and refusals. Throws badRequest for malformed
     * input; everything about the site itself comes back as a conflict or refusal.
     *
     * @param array<int, mixed> $items
     * @param array<int, mixed> $ops
     * @return array{rawItems: array<int, array<string, mixed>>, rawOps: array<int, array<string, mixed>>, items: array<string, array<string, mixed>>, ops: array<int, array<string, mixed>>, conflicts: array<int, array<string, mixed>>, refusals: array<int, array<string, mixed>>}
     */
    private function inspect(array $items, array $ops): array
    {
        $resolved = array();
        $rawItems = array();
        foreach ($items as $raw) {
            if (!is_array($raw) || !isset($raw['kind'], $raw['slug']) || !PathPolicy::isKind($raw['kind']) || !is_string($raw['slug'])) {
                throw ApiError::badRequest('Each item needs a kind and a slug.');
            }
            $create = isset($raw['create']) && $raw['create'] === true;
            $key = $raw['kind'] . ':' . $raw['slug'];
            if (isset($resolved[$key])) {
                throw ApiError::badRequest('An item is listed twice.');
            }
            $resolved[$key] = $this->resolveItem($raw['kind'], $raw['slug'], $create);
            $rawItems[] = array('kind' => $raw['kind'], 'slug' => $raw['slug'], 'create' => $create);
        }

        $manifest = new Manifest($this->storage, $this->env, 1);
        $active = $this->env->activeTheme();
        $activePlugins = $this->env->activePlugins();
        $prepared = array();
        $rawOps = array();
        $conflicts = array();
        $refusals = array();
        $seen = array();
        foreach ($ops as $raw) {
            if (!is_array($raw) || !isset($raw['op']) || ($raw['op'] !== 'put' && $raw['op'] !== 'delete')) {
                throw ApiError::badRequest('Each op is a put or a delete.');
            }
            $ref = isset($raw['item']) && is_array($raw['item']) ? $raw['item'] : array();
            $key = (isset($ref['kind']) && is_string($ref['kind']) ? $ref['kind'] : '') . ':' . (isset($ref['slug']) && is_string($ref['slug']) ? $ref['slug'] : '');
            if (!isset($resolved[$key])) {
                throw ApiError::badRequest('An op names an item that is not in the deploy.');
            }
            $item = $resolved[$key];
            $path = isset($raw['path']) && is_string($raw['path']) ? $raw['path'] : null;
            if ($path === null) {
                throw ApiError::badRequest('Each op needs a path.');
            }
            if (!array_key_exists('expected', $raw) || !($raw['expected'] === null || $raw['expected'] === 'any' || (is_string($raw['expected']) && preg_match(self::SHA, $raw['expected']) === 1))) {
                throw ApiError::badRequest('expected is a sha256, null or "any".', array('path' => $path));
            }
            $sha = null;
            $size = null;
            if ($raw['op'] === 'put') {
                $sha = isset($raw['sha256']) && is_string($raw['sha256']) && preg_match(self::SHA, $raw['sha256']) === 1 ? $raw['sha256'] : null;
                $size = isset($raw['size']) && is_int($raw['size']) && $raw['size'] >= 0 ? $raw['size'] : null;
                if ($sha === null || $size === null) {
                    throw ApiError::badRequest('A put needs its sha256 and size.', array('path' => $path));
                }
            }
            $dupe = $key . ':' . Text::lower($path);
            if (isset($seen[$dupe])) {
                throw ApiError::badRequest('A path appears twice in one deploy.', array('path' => $path));
            }
            $seen[$dupe] = true;
            $itemRef = array('kind' => $item['kind'], 'slug' => $item['slug']);
            $rawOps[] = array('op' => $raw['op'], 'item' => $itemRef, 'path' => $path, 'sha256' => $sha, 'size' => $size, 'expected' => $raw['expected']);

            $reason = $item['refusal'];
            if ($reason === null) {
                $reason = $item['isFile'] ? ($path === $item['slug'] ? null : 'traversal') : PathPolicy::validate($path);
            }
            $target = $item['isFile'] ? $item['path'] : $item['path'] . '/' . $path;
            if ($reason === null && $size !== null && $size > Protocol::MAX_FILE_BYTES) {
                $reason = 'tooLarge';
            }
            if ($reason === null) {
                $reason = $this->checkTarget($item, $target);
            }
            $current = null;
            if ($reason === null && is_file($target)) {
                $record = $manifest->statFile(array('type' => 'file', 'path' => $path, 'abs' => $target));
                if ($record['type'] !== 'file') {
                    $reason = $record['reason'] === 'tooLarge' ? 'tooLarge' : 'notWritable';
                } else {
                    $current = $manifest->hashCached($record);
                    if ($current === null) {
                        $reason = 'notWritable';
                    }
                }
            }
            if ($reason !== null) {
                $refusals[] = array('item' => $itemRef, 'path' => $path, 'reason' => $reason, 'forceable' => false);
                continue;
            }
            if ($raw['expected'] !== 'any' && $raw['expected'] !== $current) {
                $conflicts[] = array('item' => $itemRef, 'path' => $path, 'expected' => $raw['expected'], 'actual' => $current);
            }
            if ($raw['op'] === 'delete' && $current !== null) {
                $main = $item['isFile'] ? $item['slug'] : $item['slug'] . '/' . $path;
                if ($item['kind'] === 'plugin' && in_array($main, $activePlugins, true)) {
                    $refusals[] = array('item' => $itemRef, 'path' => $path, 'reason' => 'deletesActivePluginMainFile', 'forceable' => true);
                }
                $activeTheme = $item['slug'] === $active['stylesheet'] || $item['slug'] === $active['template'];
                if ($item['kind'] === 'theme' && $activeTheme && in_array($path, array('style.css', 'index.php'), true)) {
                    $refusals[] = array('item' => $itemRef, 'path' => $path, 'reason' => 'touchesActiveThemeCore', 'forceable' => true);
                }
            }
            $prepared[] = array(
                'op' => $raw['op'],
                'kind' => $item['kind'],
                'slug' => $item['slug'],
                'path' => $path,
                'sha256' => $sha,
                'size' => $size,
                'expected' => $raw['expected'],
                'target' => $target,
                'root' => $item['path'],
                'kindRoot' => $item['kindRoot'],
            );
        }
        return array('rawItems' => $rawItems, 'rawOps' => $rawOps, 'items' => $resolved, 'ops' => $prepared, 'conflicts' => $conflicts, 'refusals' => $refusals);
    }

    /**
     * @return array<string, mixed> kind, slug, path (absolute), kindRoot, isFile, exists, refusal
     */
    private function resolveItem(string $kind, string $slug, bool $create): array
    {
        if (!PathPolicy::isValidSlug($slug)) {
            $reason = PathPolicy::validate($slug);
            if ($reason === null) {
                throw ApiError::badRequest('That is not a name a theme or plugin can have.', array('slug' => $slug));
            }
            throw new ApiError('pathRejected', 'That is not a name a theme or plugin can have.', array('path' => $slug, 'reason' => $reason));
        }
        $root = $this->env->itemRoot($kind);
        $rootReal = realpath($root);
        $base = is_string($rootReal) ? $rootReal : $root;
        $path = $base . '/' . $slug;
        $item = array('kind' => $kind, 'slug' => $slug, 'path' => $path, 'kindRoot' => $base, 'isFile' => false, 'exists' => false, 'refusal' => null);
        if (is_link($path)) {
            $item['refusal'] = 'symlink';
            return $item;
        }
        if (file_exists($path)) {
            $item['exists'] = true;
            if (Paths::containedReal($path, $path) === null) {
                $item['refusal'] = 'symlink';
                return $item;
            }
            $item['isFile'] = is_file($path);
            if ($item['isFile'] ? ($kind === 'theme' || !PathPolicy::isFileItemSlug($slug)) : !is_dir($path)) {
                $item['refusal'] = 'itemUnknown';
                return $item;
            }
        } else {
            if (!$create) {
                $item['refusal'] = 'itemUnknown';
                return $item;
            }
            $item['isFile'] = $kind !== 'theme' && PathPolicy::isFileItemSlug($slug);
        }
        if ($this->resolver->isProtected($kind, $slug, $item['exists'] ? $path : null)) {
            $item['refusal'] = 'itemProtected';
            return $item;
        }
        $writable = $item['exists']
            ? ($item['isFile'] ? is_writable($path) && is_writable(dirname($path)) : is_writable($path))
            : (is_dir($base) ? is_writable($base) : is_writable(dirname($base)));
        if (!$writable) {
            $item['refusal'] = 'notWritable';
        }
        return $item;
    }

    /** No symlink or file on the way to the target, and the target is not a folder. */
    private function checkTarget(array $item, string $target): ?string
    {
        if (!$item['isFile']) {
            $dir = $item['path'];
            $rest = substr($target, strlen($item['path']) + 1);
            $parts = explode('/', $rest);
            array_pop($parts);
            foreach ($parts as $part) {
                $dir .= '/' . $part;
                if (is_link($dir)) {
                    return 'symlink';
                }
                if (file_exists($dir) && !is_dir($dir)) {
                    return 'notWritable';
                }
            }
        }
        if (is_link($target)) {
            return 'symlink';
        }
        if (is_dir($target)) {
            return 'notWritable';
        }
        return null;
    }

    /**
     * Everything commit refuses over, or null when the deploy may be applied.
     *
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>|null
     */
    private function validateForCommit(array &$deploy, bool $force): ?array
    {
        $missing = array();
        foreach ($deploy['data']['ops'] as $index => $op) {
            if ($op['op'] === 'put' && !$this->staging->has($op['sha256'], $op['size'])) {
                $missing[] = $index;
            }
        }
        if (count($missing) > 0) {
            throw ApiError::badRequest('Some files have not been uploaded yet.', array('missing' => $missing));
        }
        $plan = $this->inspect($deploy['data']['items'], $deploy['data']['rawOps']);
        $syntaxErrors = array();
        foreach ($plan['ops'] as $op) {
            if ($op['op'] !== 'put' || !SyntaxCheck::isPhp($op['path'])) {
                continue;
            }
            $code = $this->staging->readBlob($op['sha256'], Protocol::MAX_FILE_BYTES);
            $error = $code === null ? null : SyntaxCheck::check($code);
            if ($error !== null) {
                $syntaxErrors[] = array('item' => array('kind' => $op['kind'], 'slug' => $op['slug']), 'path' => $op['path'], 'line' => $error['line'], 'message' => $error['message']);
            }
        }
        $hard = array_filter($plan['refusals'], function ($refusal) {
            return !$refusal['forceable'];
        });
        $blocked = count($syntaxErrors) > 0 || count($hard) > 0
            || (!$force && (count($plan['conflicts']) > 0 || count($plan['refusals']) > 0));
        if ($blocked) {
            $out = array();
            if (count($syntaxErrors) > 0) {
                $out['syntaxErrors'] = $syntaxErrors;
            }
            if (count($plan['conflicts']) > 0) {
                $out['conflicts'] = $plan['conflicts'];
            }
            if (count($plan['refusals']) > 0) {
                $out['refusals'] = $plan['refusals'];
            }
            return $out;
        }
        $deploy['data']['ops'] = $plan['ops'];
        return null;
    }

    // Apply ----------------------------------------------------------------------------------

    /**
     * Runs the journal until it is done or the time budget is spent.
     *
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private function run(array $deploy): array
    {
        ignore_user_abort(true);
        $budget = (float) Limits::timeBudgetSeconds($this->env->iniGet('max_execution_time'));
        $total = count($deploy['data']['ops']);
        $lastPersist = $this->env->elapsed();
        try {
            while (true) {
                $journal = $deploy['data']['journal'];
                if ($journal['phase'] === 'snapshot') {
                    if ($journal['next'] >= $total) {
                        // Every snapshot is taken before the first file changes.
                        $deploy['data']['journal'] = array('phase' => 'apply', 'next' => 0);
                        $this->heartbeat($deploy);
                        continue;
                    }
                    $this->snapshotOp($deploy, $journal['next']);
                } else {
                    if ($journal['next'] >= $total) {
                        break;
                    }
                    $this->applyOp($deploy, $journal['next']);
                }
                $deploy['data']['journal']['next'] = $journal['next'] + 1;
                $elapsed = $this->env->elapsed();
                if ($elapsed > $budget) {
                    $this->heartbeat($deploy);
                    return $this->commitAnswer($deploy);
                }
                if ($elapsed - $lastPersist >= self::PERSIST_SECONDS) {
                    $this->heartbeat($deploy);
                    $lastPersist = $elapsed;
                }
            }
        } catch (ApiError $error) {
            throw $error;
        } catch (\Throwable $error) {
            // A file that cannot be written halfway through: put everything back.
            $result = $this->rollbackApplied($deploy, 'interrupted', 'The apply failed: ' . Text::clean($error->getMessage(), 200));
            return array('state' => $result['state'], 'progress' => array('done' => 0, 'total' => $total));
        }

        foreach ($this->phpTargets($deploy) as $target) {
            $this->env->invalidateOpcache($target);
        }
        $this->env->cleanCaches();
        $this->sweepTemp($deploy);
        $now = $this->env->now();
        $applied = array();
        foreach ($deploy['data']['ops'] as $index => $op) {
            clearstatcache(true, $op['target']);
            $applied[$index] = is_file($op['target']) ? array('size' => (int) filesize($op['target']), 'mtime' => (int) filemtime($op['target'])) : null;
        }
        $deploy['data']['applied'] = $applied;
        $deploy['data']['appliedAt'] = $now;
        $deploy['data']['maxDeadline'] = $now + self::MAX_CONFIRM_SECONDS;
        $deploy['data']['lastActivity'] = $now;
        $deploy['deadline'] = min($now + $this->env->confirmSeconds(), $now + self::MAX_CONFIRM_SECONDS);
        $deploy['state'] = 'applied';
        $this->save($deploy, 'applying');
        $this->publishPending($deploy);
        return $this->commitAnswer($deploy);
    }

    /** Saves journal progress and pushes the applying deadline on. */
    private function heartbeat(array &$deploy): void
    {
        $deploy['deadline'] = $this->env->now() + $this->env->confirmSeconds();
        $deploy['data']['lastActivity'] = $this->env->now();
        if (!$this->save($deploy, 'applying')) {
            throw new ApiError('invalidState', 'The deploy changed state while it was being applied.');
        }
        $this->publishPending($deploy);
    }

    private function snapshotOp(array &$deploy, int $index): void
    {
        if (isset($deploy['data']['snapshots'][$index])) {
            return;
        }
        $op = $deploy['data']['ops'][$index];
        $target = $op['target'];
        clearstatcache(true, $target);
        if (is_file($target)) {
            $kept = $this->staging->storeFile($target);
            $deploy['data']['snapshots'][$index] = array('existed' => true, 'sha256' => $kept['sha256'], 'size' => $kept['size'], 'mode' => fileperms($target) & 0777);
        } else {
            $deploy['data']['snapshots'][$index] = array('existed' => false);
        }
        if ($op['op'] === 'put') {
            // Folders this put will create, shallowest first, so a rollback can remove them again.
            $missing = array();
            $dir = dirname($target);
            while (!is_dir($dir) && strlen($dir) > strlen($op['kindRoot'])) {
                array_unshift($missing, $dir);
                $dir = dirname($dir);
            }
            if (!is_dir($op['kindRoot'])) {
                array_unshift($missing, $op['kindRoot']);
            }
            foreach ($missing as $dir) {
                if (!in_array($dir, $deploy['data']['createdDirs'], true)) {
                    $deploy['data']['createdDirs'][] = $dir;
                }
            }
        }
    }

    private function applyOp(array &$deploy, int $index): void
    {
        $op = $deploy['data']['ops'][$index];
        $target = $op['target'];
        if ($op['op'] === 'put') {
            $dir = dirname($target);
            if (!is_dir($dir) && !@mkdir($dir, $this->env->dirMode(), true) && !is_dir($dir)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
                throw new \RuntimeException('Could not create the folder for ' . $op['path'] . '.');
            }
            $snapshot = $deploy['data']['snapshots'][$index];
            $mode = !empty($snapshot['existed']) && isset($snapshot['mode']) ? (int) $snapshot['mode'] : $this->env->fileMode();
            $this->writer->copy($this->staging->blobPath($op['sha256']), $target, $mode);
            return;
        }
        if (is_file($target) && !is_link($target) && !@unlink($target)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
            throw new \RuntimeException('Could not delete ' . $op['path'] . '.');
        }
    }

    // Rollback -------------------------------------------------------------------------------

    /**
     * Puts back every file the deploy touched, from its snapshot.
     *
     * @param array<string, mixed> $deploy
     * @return array{restored: int, removed: int}
     */
    private function restore(array $deploy): array
    {
        $restored = 0;
        $removed = 0;
        $ops = $deploy['data']['ops'];
        $snapshots = (array) $deploy['data']['snapshots'];
        for ($index = count($ops) - 1; $index >= 0; $index--) {
            if (!isset($snapshots[$index])) {
                continue;
            }
            $snapshot = $snapshots[$index];
            $target = $ops[$index]['target'];
            if (!empty($snapshot['existed'])) {
                $blob = $this->staging->blobPath($snapshot['sha256']);
                if (!is_file($blob)) {
                    throw new \RuntimeException('The saved copy of ' . $ops[$index]['path'] . ' is gone.');
                }
                $dir = dirname($target);
                if (!is_dir($dir) && !@mkdir($dir, $this->env->dirMode(), true) && !is_dir($dir)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_mkdir
                    throw new \RuntimeException('Could not recreate the folder for ' . $ops[$index]['path'] . '.');
                }
                if (!is_file($target) || hash_file('sha256', $target) !== $snapshot['sha256']) {
                    $this->writer->copy($blob, $target, isset($snapshot['mode']) ? (int) $snapshot['mode'] : $this->env->fileMode());
                }
                $restored++;
            } elseif (is_file($target) && !is_link($target)) {
                if (!@unlink($target)) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
                    throw new \RuntimeException('Could not remove ' . $ops[$index]['path'] . '.');
                }
                $removed++;
            }
        }
        $this->sweepTemp($deploy);
        foreach (array_reverse((array) $deploy['data']['createdDirs']) as $dir) {
            AtomicWriter::sweep($dir);
            if (is_dir($dir) && !is_link($dir)) {
                @rmdir($dir); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged, WordPress.WP.AlternativeFunctions.file_system_operations_rmdir
            }
        }
        foreach ($this->phpTargets($deploy) as $target) {
            $this->env->invalidateOpcache($target);
        }
        $this->env->cleanCaches();
        return array('restored' => $restored, 'removed' => $removed);
    }

    /**
     * @param array<string, mixed> $deploy
     * @return array{state: string, reason: string, restored: int, removed: int}
     */
    private function rollbackApplied(array $deploy, string $reason, ?string $note = null): array
    {
        $from = $deploy['state'];
        $counts = $this->restore($deploy);
        $this->finish($deploy, 'rolledBack', $reason, $from, $note);
        return array('state' => 'rolledBack', 'reason' => $reason, 'restored' => $counts['restored'], 'removed' => $counts['removed']);
    }

    /**
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private function rollbackDone(array $deploy, bool $force): array
    {
        if (empty($deploy['data']['snapshotKept'])) {
            throw new ApiError('invalidState', 'The saved copies for this deploy are no longer kept, so it cannot be rolled back.', array('state' => 'done'));
        }
        $holder = $this->holder();
        if ($holder !== null) {
            throw new ApiError('busy', 'Another deploy is open on this site.', array('deployId' => $holder['id']));
        }
        $conflicts = $this->changedSince($deploy);
        if (count($conflicts) > 0 && !$force) {
            return array('state' => 'done', 'restored' => 0, 'removed' => 0, 'conflicts' => $conflicts);
        }
        $counts = $this->restore($deploy);
        $this->finish($deploy, 'rolledBack', 'requested', 'done');
        $out = array('state' => 'rolledBack', 'reason' => 'requested', 'restored' => $counts['restored'], 'removed' => $counts['removed']);
        if (count($conflicts) > 0) {
            $out['conflicts'] = $conflicts;
        }
        return $out;
    }

    /**
     * Files that changed after the deploy wrote them.
     *
     * @param array<string, mixed> $deploy
     * @return array<int, array<string, mixed>>
     */
    private function changedSince(array $deploy): array
    {
        $conflicts = array();
        foreach ($deploy['data']['ops'] as $op) {
            $target = $op['target'];
            clearstatcache(true, $target);
            $actual = is_file($target) ? hash_file('sha256', $target) : null;
            $expected = $op['op'] === 'put' ? $op['sha256'] : null;
            if ($actual !== $expected) {
                $conflicts[] = array('item' => array('kind' => $op['kind'], 'slug' => $op['slug']), 'path' => $op['path'], 'expected' => $expected, 'actual' => $actual === false ? null : $actual);
            }
        }
        return $conflicts;
    }

    /**
     * Cheap check for history: sizes and mtimes as the apply left them. mtime has one-second
     * steps, so a file written in the last two seconds is checked by its hash instead.
     */
    private function unchangedSince(array $deploy): bool
    {
        $applied = (array) $deploy['data']['applied'];
        foreach ($deploy['data']['ops'] as $index => $op) {
            $target = $op['target'];
            clearstatcache(true, $target);
            $now = is_file($target) ? array('size' => (int) filesize($target), 'mtime' => (int) filemtime($target)) : null;
            $then = isset($applied[$index]) ? $applied[$index] : null;
            if ($now !== $then) {
                return false;
            }
            if ($now !== null && $now['mtime'] >= time() - 2 && hash_file('sha256', $target) !== $op['sha256']) {
                return false;
            }
        }
        return true;
    }

    // State bookkeeping ----------------------------------------------------------------------

    /**
     * Moves a deploy to a final state and lets go of everything it held.
     *
     * @param array<string, mixed> $deploy
     */
    private function finish(array $deploy, string $state, ?string $reason, string $from, ?string $note = null): void
    {
        $now = $this->env->now();
        $deploy['state'] = $state;
        $deploy['reason'] = $reason;
        $deploy['finished_at'] = $now;
        $deploy['deadline'] = null;
        $deploy['data']['snapshotKept'] = $state === 'done';
        $deploy['data']['lastActivity'] = $now;
        if (!$this->save($deploy, $from)) {
            throw new ApiError('invalidState', 'The deploy changed state at the same time.', array('state' => $this->load($deploy['id'])['state']));
        }
        $this->releaseLock($deploy['id']);
        $this->env->setGuardState(null);
        $this->storage->kvDelete(SiteInfo::PENDING_KEY);
        $events = array('done' => 'deployDone', 'rolledBack' => 'deployRolledBack', 'aborted' => 'deployAborted', 'expired' => 'deployAborted');
        $details = array(
            'done' => 'Finished',
            'rolledBack' => 'Rolled back (' . (string) $reason . ')',
            'aborted' => 'Aborted',
            'expired' => 'Expired after 30 minutes without a call',
        );
        $detail = $details[$state] . ': "' . $deploy['label'] . '".' . ($note !== null ? ' ' . $note : '');
        $this->audit->add($events[$state], $now, '', $detail, array('id' => $deploy['connection_id'], 'label' => $deploy['connection_label']));
        $this->prune();
    }

    /**
     * Rolls back (or aborts) whatever is pending, for when the guard is about to go away.
     */
    public function abandonPending(string $why): void
    {
        $this->locked(function () use ($why) {
            $holder = $this->holder();
            if ($holder === null) {
                return;
            }
            if ($holder['state'] === 'open') {
                $this->finish($holder, 'aborted', null, 'open', $why);
                return;
            }
            $this->rollbackApplied($holder, 'interrupted', $why);
        });
    }

    /** Keeps 20 deploys of history and the snapshots of the 5 newest finished ones. */
    private function prune(): void
    {
        $keep = array();
        $finished = 0;
        $snapshots = 0;
        foreach ($this->storage->listDeploys(200) as $row) {
            $deploy = $this->decode($row);
            $active = StateMachine::isActive($deploy['state']);
            if (!$active && ++$finished > self::KEEP_HISTORY) {
                $this->storage->deleteDeploy($deploy['id']);
                continue;
            }
            if ($deploy['state'] === 'done' && !empty($deploy['data']['snapshotKept'])) {
                if (++$snapshots > self::KEEP_SNAPSHOTS) {
                    $deploy['data']['snapshotKept'] = false;
                    $this->save($deploy, 'done');
                    continue;
                }
            }
            if ($active || ($deploy['state'] === 'done' && !empty($deploy['data']['snapshotKept']))) {
                foreach ((array) $deploy['data']['snapshots'] as $snapshot) {
                    if (!empty($snapshot['existed'])) {
                        $keep[] = $snapshot['sha256'];
                    }
                }
            }
            if ($active) {
                foreach ($deploy['data']['ops'] as $op) {
                    if ($op['op'] === 'put') {
                        $keep[] = $op['sha256'];
                    }
                }
            }
        }
        $holder = $this->storage->kvGet(self::LOCK, $this->env->now());
        $this->staging->dropParts($holder !== null ? array($holder) : array());
        $this->staging->collect(array_values(array_unique($keep)));
    }

    /**
     * Lazy timeouts: an idle open deploy expires; an applying or applied one past its deadline is
     * rolled back (interrupted or notConfirmed).
     *
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private function refresh(array $deploy): array
    {
        $now = $this->env->now();
        if ($deploy['state'] === 'open' && $now - (int) $deploy['data']['lastActivity'] > self::IDLE_SECONDS) {
            $this->finish($deploy, 'expired', null, 'open');
            return $this->load($deploy['id']);
        }
        if (($deploy['state'] === 'applying' || $deploy['state'] === 'applied') && $deploy['deadline'] !== null && $now > $deploy['deadline']) {
            $this->rollbackApplied($deploy, $deploy['state'] === 'applying' ? 'interrupted' : 'notConfirmed');
            return $this->load($deploy['id']);
        }
        return $deploy;
    }

    /**
     * The deploy holding the lock, after its timeouts are applied. Clears a stale lock.
     *
     * @return array<string, mixed>|null
     */
    private function holder(): ?array
    {
        $id = $this->storage->kvGet(self::LOCK, $this->env->now());
        if ($id === null) {
            return null;
        }
        $row = $this->storage->getDeploy($id);
        if ($row === null || !StateMachine::isActive($row['state'])) {
            $this->releaseLock($id);
            return null;
        }
        $deploy = $this->refresh($this->decode($row));
        return StateMachine::isActive($deploy['state']) ? $deploy : null;
    }

    private function acquireLock(string $id): bool
    {
        $now = $this->env->now();
        if ($this->storage->kvAdd(self::LOCK, $id, null, $now)) {
            return true;
        }
        // The holder may be finished or gone; holder() clears such a lock.
        return $this->holder() === null && $this->storage->kvAdd(self::LOCK, $id, null, $now);
    }

    private function releaseLock(string $id): void
    {
        if ($this->storage->kvGet(self::LOCK, $this->env->now()) === $id) {
            $this->storage->kvDelete(self::LOCK);
        }
    }

    /**
     * Runs $work holding the site's deploy mutex; busy when another call holds it.
     *
     * @return mixed
     */
    private function locked(callable $work)
    {
        if ($this->mutex !== null) {
            return $work();
        }
        $token = bin2hex(random_bytes(8));
        $now = $this->env->now();
        if (!$this->storage->kvAdd(self::MUTEX, $token, $now + self::MUTEX_SECONDS, $now)) {
            throw new ApiError('busy', 'Another deploy call is still running on this site. Try again in a few seconds.', array('retryAfter' => 5));
        }
        $this->mutex = $token;
        try {
            return $work();
        } finally {
            if ($this->storage->kvGet(self::MUTEX, $this->env->now()) === $token) {
                $this->storage->kvDelete(self::MUTEX);
            }
            $this->mutex = null;
        }
    }

    /**
     * Runs $work while no deploy is open and no other deploy call is running, and keeps new ones
     * out until it returns. The connector update uses it: it changes the files every deploy relies on.
     *
     * @return mixed
     */
    public function whileIdle(callable $work)
    {
        return $this->locked(function () use ($work) {
            $holder = $this->holder();
            if ($holder !== null) {
                throw new ApiError('busy', 'A deploy is still open on this site. Finish or cancel it first.', array('deployId' => $holder['id']));
            }
            return $work();
        });
    }

    /** Like locked(), but quietly does nothing when another call holds the mutex. */
    private function tryLocked(callable $work): bool
    {
        try {
            $this->locked($work);
            return true;
        } catch (ApiError $error) {
            if ($error->errorCode === 'busy' && $this->mutex === null) {
                return false;
            }
            throw $error;
        }
    }

    // Helpers --------------------------------------------------------------------------------

    /**
     * @return array<string, mixed>
     */
    private function load(string $id): array
    {
        $row = $this->storage->getDeploy($id);
        if ($row === null) {
            throw new ApiError('deployUnknown', 'This site has no deploy with that id.', array('deployId' => $id));
        }
        return $this->decode($row);
    }

    /**
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function decode(array $row): array
    {
        $data = Json::decode($row['data']);
        $row['data'] = is_array($data) ? $data : array();
        $row['data'] += array(
            'ops' => array(),
            'rawOps' => array(),
            'items' => array(),
            'snapshots' => array(),
            'createdDirs' => array(),
            'applied' => array(),
            'baseline' => array(),
            'journal' => array('phase' => 'snapshot', 'next' => 0),
            'lastActivity' => $row['updated_at'],
            'maxDeadline' => null,
            'snapshotKept' => false,
        );
        return $row;
    }

    /**
     * @param array<string, mixed> $deploy
     */
    private function save(array $deploy, ?string $expectedState): bool
    {
        return $this->storage->updateDeploy($deploy['id'], array(
            'state' => $deploy['state'],
            'reason' => $deploy['reason'],
            'updated_at' => $this->env->now(),
            'finished_at' => $deploy['finished_at'],
            'deadline' => $deploy['deadline'],
            'data' => Json::encode($deploy['data']),
        ), $expectedState);
    }

    /** Tells the guard and /site/info about the deploy in flight. */
    private function publishPending(array $deploy): void
    {
        $this->setPending($deploy['id'], $deploy['state'], (int) $deploy['deadline']);
        $this->env->setGuardState(array('d' => $deploy['id'], 't' => (int) $deploy['deadline'], 'f' => $this->phpTargets($deploy)));
    }

    private function setPending(string $id, string $state, int $deadline): void
    {
        $this->storage->kvSet(SiteInfo::PENDING_KEY, Json::encode(array('deployId' => $id, 'state' => $state, 'deadline' => $deadline)), null);
    }

    /**
     * Absolute paths of the PHP files the deploy writes or deletes.
     *
     * @return string[]
     */
    private function phpTargets(array $deploy): array
    {
        $out = array();
        foreach ($deploy['data']['ops'] as $op) {
            if (SyntaxCheck::isPhp($op['target'])) {
                $out[] = $op['target'];
            }
        }
        return $out;
    }

    private function sweepTemp(array $deploy): void
    {
        $dirs = array();
        foreach ($deploy['data']['ops'] as $op) {
            $dirs[dirname($op['target'])] = true;
        }
        foreach (array_keys($dirs) as $dir) {
            AtomicWriter::sweep($dir);
        }
    }

    /**
     * @param array<int, array<string, mixed>> $checks
     */
    private function rememberLoopback(array $checks): void
    {
        $verdict = 'unknown';
        foreach ($checks as $check) {
            if ($check['ok'] === true) {
                $verdict = 'ok';
            } elseif ($check['ok'] === false) {
                $verdict = 'failed';
                break;
            }
        }
        $this->storage->kvSet(SiteInfo::LOOPBACK_KEY, $verdict, null);
    }

    /**
     * False when a check that passed before the deploy fails now; true when something passed and
     * nothing regressed; null when nothing could be judged.
     *
     * @param array<int, mixed> $baseline
     * @param array<int, array<string, mixed>> $now
     */
    public static function health(array $baseline, array $now): ?bool
    {
        $before = array();
        foreach ($baseline as $check) {
            if (is_array($check) && isset($check['name'])) {
                $before[$check['name']] = isset($check['ok']) ? $check['ok'] : null;
            }
        }
        $any = false;
        foreach ($now as $check) {
            $was = isset($before[$check['name']]) ? $before[$check['name']] : null;
            if ($was === true && $check['ok'] === false) {
                return false;
            }
            if ($check['ok'] === true) {
                $any = true;
            }
        }
        return $any ? true : null;
    }

    /**
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private function record(array $deploy): array
    {
        $record = array(
            'deployId' => $deploy['id'],
            'state' => $deploy['state'],
            'label' => $deploy['label'],
            'startedAt' => $deploy['started_at'],
            'finishedAt' => $deploy['finished_at'],
            'connectionLabel' => $deploy['connection_label'],
            'puts' => $deploy['puts'],
            'deletes' => $deploy['deletes'],
            'canRollback' => $deploy['state'] === 'done' && !empty($deploy['data']['snapshotKept']) && $this->unchangedSince($deploy),
        );
        if ($deploy['reason'] !== null) {
            $record['reason'] = $deploy['reason'];
        }
        return $record;
    }

    /**
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private function commitAnswer(array $deploy): array
    {
        $total = count($deploy['data']['ops']);
        $done = $deploy['state'] === 'applying'
            ? ($deploy['data']['journal']['phase'] === 'apply' ? (int) $deploy['data']['journal']['next'] : 0)
            : (in_array($deploy['state'], array('applied', 'done'), true) ? $total : 0);
        return array('state' => $deploy['state'], 'progress' => array('done' => $done, 'total' => $total));
    }

    /**
     * @param array<string, mixed> $deploy
     * @return array<string, mixed>
     */
    private static function stateAnswer(array $deploy): array
    {
        $out = array('state' => $deploy['state']);
        if ($deploy['reason'] !== null) {
            $out['reason'] = $deploy['reason'];
        }
        return $out;
    }

    /** Throws invalidState when the table says the action does not apply to this state. */
    private function expect(string $action, array $deploy): void
    {
        if (StateMachine::decide($action, $deploy['state']) === 'invalid') {
            $details = array('state' => $deploy['state']);
            if ($deploy['reason'] !== null) {
                $details['reason'] = $deploy['reason'];
            }
            throw new ApiError('invalidState', 'That cannot be done to a deploy that is ' . $deploy['state'] . '.', $details);
        }
    }

    /**
     * @param mixed $body
     */
    private static function deployId($body): string
    {
        $id = is_array($body) && isset($body['deployId']) ? $body['deployId'] : null;
        if (!is_string($id) || preg_match(self::ID, $id) !== 1) {
            throw ApiError::badRequest('deployId is the id /deploy/begin gave out.');
        }
        return $id;
    }

    /**
     * @param mixed $value
     */
    private static function isList($value): bool
    {
        return is_array($value) && array_values($value) === $value;
    }
}
