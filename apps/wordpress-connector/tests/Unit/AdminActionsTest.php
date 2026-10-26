<?php
/**
 * wp-admin actions: capability first, then the nonce, then the work.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Tests\Unit;

use Runova\Connector\Admin\AdminActions;
use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\ConnectionKey;
use Runova\Connector\Auth\KeyService;
use Runova\Connector\Deploy\DeployService;
use Runova\Connector\Tests\Support\DeployTestCase;
use Runova\Connector\Tests\Support\FakeAdminContext;

final class AdminActionsTest extends DeployTestCase
{
    /** @var FakeAdminContext */
    private $admin;

    protected function setUp(): void
    {
        parent::setUp();
        $this->admin = new FakeAdminContext();
    }

    private function actions(): AdminActions
    {
        $storage = $this->storage;
        $env = $this->env;
        $keys = $this->siteKeys;
        return new AdminActions(
            $storage,
            $env,
            $this->admin,
            function () use ($storage, $env, $keys) {
                return new KeyService($storage, $env, $keys, new AuditLog($storage));
            },
            new DeployService($storage, $env, new AuditLog($storage))
        );
    }

    private function allow(string $action, string $id = ''): void
    {
        $this->admin->nonces[] = AdminActions::nonceAction($action, $id);
    }

    public function testCreateKey(): void
    {
        $fields = array('scope' => 'write', 'label' => 'Office', 'expires' => 30);
        $this->assertSame(array('status' => 'refused', 'code' => 'nonce'), $this->actions()->run('create_key', $fields));
        $this->allow('create_key');
        $result = $this->actions()->run('create_key', $fields);
        $this->assertSame('done', $result['status']);
        $this->assertSame('write', $result['data']['scope']);
        $parsed = ConnectionKey::parse($result['data']['key'], $this->env->now);
        $this->assertTrue($parsed['ok']);
        $this->assertSame('Office', $parsed['key']['label']);
        $pairing = $this->storage->getPairing($parsed['key']['pairingId']);
        $this->assertSame(3, $pairing['created_by']);
        $this->assertSame(30 * 86400, $pairing['connection_ttl']);
    }

    public function testCreateKeyValidation(): void
    {
        $this->allow('create_key');
        $this->assertSame('scope', $this->actions()->run('create_key', array('scope' => 'admin', 'expires' => 0))['code']);
        $this->assertSame('expiry', $this->actions()->run('create_key', array('scope' => 'read', 'expires' => 5))['code']);
        $this->assertSame('label', $this->actions()->run('create_key', array('scope' => 'read', 'expires' => 0, 'label' => str_repeat('x', 101)))['code']);
        $this->assertCount(0, $this->storage->pairings);
    }

    public function testWriteKeysNeedTheRightsToInstallCode(): void
    {
        $this->allow('create_key');
        $this->admin->capabilities = array('manage_options');
        $this->assertSame(array('status' => 'refused', 'code' => 'capability'), $this->actions()->run('create_key', array('scope' => 'write', 'expires' => 0)));
        $this->assertSame('done', $this->actions()->run('create_key', array('scope' => 'read', 'expires' => 0))['status']);
    }

    public function testEveryActionNeedsTheBaseCapabilityBeforeAnything(): void
    {
        $id = $this->connect('read');
        $this->allow('create_key');
        $this->allow('revoke', $id);
        $this->admin->capabilities = array('edit_posts', 'install_plugins', 'install_themes');
        foreach (array('create_key', 'revoke', 'rollback') as $action) {
            $this->assertSame(array('status' => 'refused', 'code' => 'capability'), $this->actions()->run($action, array('id' => $id, 'scope' => 'read', 'expires' => 0)), $action);
        }
        $this->assertNull($this->storage->getConnection($id)['revoked_at']);
    }

    public function testMultisiteNeedsManageNetworkOptions(): void
    {
        $this->admin->multisite = true;
        $this->allow('create_key');
        $this->assertSame('capability', $this->actions()->run('create_key', array('scope' => 'read', 'expires' => 0))['code']);
        $this->admin->capabilities[] = 'manage_network_options';
        $this->assertSame('done', $this->actions()->run('create_key', array('scope' => 'read', 'expires' => 0))['status']);
    }

    public function testRevoke(): void
    {
        $id = $this->connect('write');
        // A nonce for another connection does not count.
        $this->allow('revoke', 'someone-else');
        $this->assertSame(array('status' => 'refused', 'code' => 'nonce'), $this->actions()->run('revoke', array('id' => $id)));
        $this->assertNull($this->storage->getConnection($id)['revoked_at']);

        $this->allow('revoke', $id);
        $this->assertSame(array('status' => 'done', 'code' => 'revoked'), $this->actions()->run('revoke', array('id' => $id)));
        $this->assertSame($this->env->now, $this->storage->getConnection($id)['revoked_at']);
        $last = end($this->storage->audit);
        $this->assertSame('revoked', $last['event']);
        $this->assertSame('Revoked in wp-admin by user #3.', $last['detail']);
        $this->assertSame('alreadyRevoked', $this->actions()->run('revoke', array('id' => $id))['code']);
        $this->assertError('revoked', $this->call('/site/info', null, array('connectionId' => $id)));

        $this->allow('revoke', 'missing');
        $this->assertSame('unknownConnection', $this->actions()->run('revoke', array('id' => 'missing'))['code']);
    }

    public function testRollback(): void
    {
        $deployId = $this->apply($this->themeChange());
        $this->assertOk($this->route('/deploy/finalize', $deployId));

        $this->assertSame('nonce', $this->actions()->run('rollback', array('id' => $deployId))['code']);
        $this->allow('rollback', $deployId);
        $this->admin->capabilities = array('manage_options');
        $this->assertSame(array('status' => 'refused', 'code' => 'capability'), $this->actions()->run('rollback', array('id' => $deployId)), 'Rolling back changes code.');
        $this->assertSame('done', $this->stateOf($deployId));

        $this->admin->capabilities = array('manage_options', 'install_plugins', 'install_themes');
        $result = $this->actions()->run('rollback', array('id' => $deployId));
        $this->assertSame(array('status' => 'done', 'code' => 'rolledBack', 'data' => array('restored' => 2, 'removed' => 1)), $result);
        $this->assertSame('<?php // v1', $this->read('themes/twentytwentyfive/functions.php'));
        // A repeat is safe: nothing more is touched.
        $this->assertSame(array('status' => 'done', 'code' => 'rolledBack', 'data' => array('restored' => 0, 'removed' => 0)), $this->actions()->run('rollback', array('id' => $deployId)));
    }

    public function testRollbackRefusesWhenFilesChangedSince(): void
    {
        $deployId = $this->apply($this->themeChange());
        $this->assertOk($this->route('/deploy/finalize', $deployId));
        file_put_contents($this->path('themes/twentytwentyfive/functions.php'), '<?php // edited');
        $this->allow('rollback', $deployId);
        $result = $this->actions()->run('rollback', array('id' => $deployId));
        $this->assertSame(array('status' => 'error', 'code' => 'conflicts', 'data' => array('count' => 1)), $result);
        $this->assertSame('<?php // edited', $this->read('themes/twentytwentyfive/functions.php'));

        $missing = '00000000-0000-4000-8000-000000000000';
        $this->allow('rollback', $missing);
        $this->assertSame('deployUnknown', $this->actions()->run('rollback', array('id' => $missing))['code']);
    }

    public function testUnknownActions(): void
    {
        $this->assertSame('unknownAction', $this->actions()->run('delete_everything', array())['code']);
    }
}
