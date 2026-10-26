<?php
/**
 * Everything the wp-admin pages can change: create a key, revoke a connection, roll back a deploy,
 * and move a connector that still runs from its 1.63 folder to its own.
 * Each action checks the capability first, then the nonce, then does the work. The page turns the
 * result codes into words; nothing here prints anything.
 *
 * Capabilities: manage_options (manage_network_options on multisite) for everything; write keys
 * and rollbacks change code, so they also need install_plugins and install_themes.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Admin;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\KeyService;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Env\Environment;
use Runova\Connector\Http\ApiError;
use Runova\Connector\Storage\Storage;

final class AdminActions
{
    const CREATE_KEY = 'create_key';
    const REVOKE = 'revoke';
    const ROLLBACK = 'rollback';
    const MIGRATE = 'migrate';

    const EXPIRY_CHOICES = array(0, 1, 7, 30, 90, 365);

    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var AdminContext */
    private $context;

    /** @var callable(): KeyService */
    private $keys;

    /** @var DeployService */
    private $deploys;

    /** @var callable|null */
    private $migration;

    /**
     * @param callable(): KeyService $keys built only when a key is made (it loads the site key)
     * @param callable|null $migration callable(): LayoutMigration, built only for a move
     */
    public function __construct(Storage $storage, Environment $env, AdminContext $context, callable $keys, DeployService $deploys, ?callable $migration = null)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->context = $context;
        $this->keys = $keys;
        $this->deploys = $deploys;
        $this->migration = $migration;
    }

    /** The nonce action for a form. Per object for revoke and rollback. */
    public static function nonceAction(string $action, string $id = ''): string
    {
        return 'runova_connector_' . $action . ($id !== '' ? '_' . $id : '');
    }

    public function baseCapability(): string
    {
        return $this->context->multisite() ? 'manage_network_options' : 'manage_options';
    }

    /** May this user change code on the site (write keys, rollbacks)? */
    public function canChangeCode(): bool
    {
        return $this->context->can($this->baseCapability()) && $this->context->can('install_plugins') && $this->context->can('install_themes');
    }

    /**
     * @param array<string, mixed> $fields sanitized form fields
     * @return array{status: string, code: string, data?: array<string, mixed>} status is refused, error or done
     */
    public function run(string $action, array $fields): array
    {
        if (!in_array($action, array(self::CREATE_KEY, self::REVOKE, self::ROLLBACK, self::MIGRATE), true)) {
            return self::result('error', 'unknownAction');
        }
        if (!$this->context->can($this->baseCapability())) {
            return self::result('refused', 'capability');
        }
        $id = isset($fields['id']) && is_string($fields['id']) ? $fields['id'] : '';
        if (!$this->context->nonceOk(self::nonceAction($action, in_array($action, array(self::CREATE_KEY, self::MIGRATE), true) ? '' : $id))) {
            return self::result('refused', 'nonce');
        }
        if ($action === self::CREATE_KEY) {
            return $this->createKey($fields);
        }
        if ($action === self::REVOKE) {
            return $this->revoke($id);
        }
        if (!$this->canChangeCode()) {
            return self::result('refused', 'capability');
        }
        if ($action === self::MIGRATE) {
            return $this->migrate();
        }
        return $this->rollback($id);
    }

    /**
     * @return array{status: string, code: string, data?: array<string, mixed>}
     */
    private function migrate(): array
    {
        if ($this->migration === null) {
            return self::result('error', 'failed');
        }
        try {
            $result = call_user_func($this->migration)->migrate(null, $this->context->ip());
        } catch (ApiError $error) {
            return self::result('error', $error->errorCode === 'busy' ? 'busy' : 'moveRefused');
        }
        return $result['state'] === 'rolledBack' ? self::result('error', 'moveRolledBack') : self::result('done', 'moved');
    }

    /**
     * @param array<string, mixed> $fields
     * @return array{status: string, code: string, data?: array<string, mixed>}
     */
    private function createKey(array $fields): array
    {
        $scope = isset($fields['scope']) ? $fields['scope'] : 'read';
        $label = isset($fields['label']) && is_string($fields['label']) ? $fields['label'] : '';
        $days = isset($fields['expires']) ? $fields['expires'] : 0;
        if ($scope !== 'read' && $scope !== 'write') {
            return self::result('error', 'scope');
        }
        if ($scope === 'write' && !$this->canChangeCode()) {
            return self::result('refused', 'capability');
        }
        if (!is_int($days) || !in_array($days, self::EXPIRY_CHOICES, true)) {
            return self::result('error', 'expiry');
        }
        if (KeyService::cleanLabel($label) === null) {
            return self::result('error', 'label');
        }
        $created = call_user_func($this->keys)->create($scope, $label, $days === 0 ? null : $days, $this->context->userId(), $this->context->ip());
        return self::result('done', 'keyCreated', array('key' => $created['key'], 'expiresAt' => $created['expiresAt'], 'scope' => $scope));
    }

    /**
     * @return array{status: string, code: string, data?: array<string, mixed>}
     */
    private function revoke(string $id): array
    {
        $connection = $id !== '' ? $this->storage->getConnection($id) : null;
        if ($connection === null) {
            return self::result('error', 'unknownConnection');
        }
        if ($connection['revoked_at'] !== null) {
            return self::result('done', 'alreadyRevoked');
        }
        $now = $this->env->now();
        $this->storage->revokeConnection($id, $now);
        (new AuditLog($this->storage))->add('revoked', $now, $this->context->ip(), 'Revoked in wp-admin by user #' . $this->context->userId() . '.', $connection);
        return self::result('done', 'revoked');
    }

    /**
     * @return array{status: string, code: string, data?: array<string, mixed>}
     */
    private function rollback(string $id): array
    {
        try {
            $result = $this->deploys->rollback(array('deployId' => $id));
        } catch (ApiError $error) {
            $codes = array('deployUnknown' => 'deployUnknown', 'busy' => 'busy', 'invalidState' => 'notRollbackable', 'badRequest' => 'deployUnknown');
            return self::result('error', isset($codes[$error->errorCode]) ? $codes[$error->errorCode] : 'failed');
        }
        if (isset($result['conflicts']) && $result['state'] !== 'rolledBack') {
            return self::result('error', 'conflicts', array('count' => count($result['conflicts'])));
        }
        if ($result['state'] !== 'rolledBack') {
            return self::result('error', 'notRollbackable');
        }
        return self::result('done', 'rolledBack', array('restored' => $result['restored'], 'removed' => $result['removed']));
    }

    /**
     * @param array<string, mixed> $data
     * @return array{status: string, code: string, data?: array<string, mixed>}
     */
    private static function result(string $status, string $code, array $data = array()): array
    {
        $out = array('status' => $status, 'code' => $code);
        if (count($data) > 0) {
            $out['data'] = $data;
        }
        return $out;
    }
}
