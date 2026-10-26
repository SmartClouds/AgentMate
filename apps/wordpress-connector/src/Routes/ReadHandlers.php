<?php
/**
 * The read routes: /site/info, /items/list, /items/manifest, /files/read, /audit/list and
 * /connection/revoke (a key may always revoke itself, so revoke counts as read).
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Env\Environment;
use Runova\Connector\Files\FileReader;
use Runova\Connector\Files\ItemResolver;
use Runova\Connector\Files\Manifest;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Info\Items;
use Runova\Connector\Info\Limits;
use Runova\Connector\Info\SiteInfo;
use Runova\Connector\Storage\Storage;

final class ReadHandlers implements Handler
{
    /** One "pulled" audit entry per connection and item in this many seconds. */
    const PULL_AUDIT_SECONDS = 600;

    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var AuditLog */
    private $audit;

    /** @var ItemResolver */
    private $resolver;

    public function __construct(Storage $storage, Environment $env, AuditLog $audit)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->audit = $audit;
        $this->resolver = new ItemResolver($env);
    }

    /** @return string[] */
    public static function routes(): array
    {
        return array('/site/info', '/items/list', '/items/manifest', '/files/read', '/audit/list', '/connection/revoke');
    }

    public function handle(RequestContext $context): Result
    {
        switch ($context->route) {
            case '/site/info':
                // Apply idle expiry and deadlines first, so pendingDeploy is never stale.
                (new DeployService($this->storage, $this->env, $this->audit))->checkPending();
                return new Result((new SiteInfo($this->env, $this->storage))->build($context->connection));
            case '/items/list':
                return new Result(array('items' => (new Items($this->env, $this->resolver))->all()));
            case '/items/manifest':
                return $this->manifest($context);
            case '/files/read':
                return $this->readFiles($context);
            case '/audit/list':
                return $this->auditList($context);
            case '/connection/revoke':
                return $this->revoke($context);
        }
        throw ApiError::badRequest('That route is not handled here.');
    }

    private function manifest(RequestContext $context): Result
    {
        $item = $this->resolver->resolve($context->field('item'));
        $cursor = $context->field('cursor');
        $limits = Limits::forEnvironment($this->env);
        $manifest = new Manifest($this->storage, $this->env, $limits['manifestPageSize']);
        $page = $manifest->page($item, $cursor, (float) $limits['timeBudgetSeconds']);
        if ($cursor === null) {
            $this->auditPull($context, $item['kind'] . ':' . $item['slug']);
        }
        return new Result($page);
    }

    private function readFiles(RequestContext $context): Result
    {
        $item = $this->resolver->resolve($context->field('item'));
        $limits = Limits::forEnvironment($this->env);
        $manifest = new Manifest($this->storage, $this->env, $limits['manifestPageSize']);
        $read = (new FileReader($manifest))->read($item, $context->field('files'), $limits['maxResponseBytes'], $limits['maxPathsPerRead']);
        return new Result(array('files' => $read['files']), $read['blobs']);
    }

    private function auditList(RequestContext $context): Result
    {
        $limit = $context->field('limit', 100);
        $before = $context->field('before');
        if (!is_int($limit) || $limit < 1) {
            throw ApiError::badRequest('limit is a whole number from 1.');
        }
        if ($before !== null && (!is_int($before) || $before < 1)) {
            throw ApiError::badRequest('before is an audit entry id.');
        }
        return new Result(array('entries' => $this->audit->entries(min($limit, 500), $before)));
    }

    private function revoke(RequestContext $context): Result
    {
        $this->storage->revokeConnection($context->connection['id'], $context->now);
        $this->audit->add('revoked', $context->now, $context->ip, 'The connection revoked itself.', $context->connection);
        return new Result(array('revoked' => true));
    }

    private function auditPull(RequestContext $context, string $itemKey): void
    {
        $key = 'pulled:' . hash('sha256', $context->connection['id'] . "\n" . $itemKey);
        if ($this->storage->kvGet($key, $context->now) !== null) {
            return;
        }
        $this->storage->kvSet($key, '1', $context->now + self::PULL_AUDIT_SECONDS);
        $this->audit->add('pulled', $context->now, $context->ip, 'Listed ' . $itemKey . ' for a pull or a deploy plan.', $context->connection);
    }
}
