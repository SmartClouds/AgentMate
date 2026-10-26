<?php
/**
 * The plugin's tables, in the form dbDelta() wants. They use the base prefix, so on multisite
 * there is one set for the whole network, like the themes and plugins they guard.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

final class Schema
{
    const VERSION = '4';

    const TABLES = array('connections', 'pairings', 'nonces', 'audit', 'deploys', 'hash_cache', 'kv');

    public static function table(string $basePrefix, string $name): string
    {
        // The names from before the rename: renaming a table needs rights many hosts do not grant.
        return $basePrefix . Legacy::TABLE_PREFIX . $name;
    }

    /**
     * @return string[] one CREATE TABLE per table
     */
    public static function sql(string $basePrefix, string $collate): array
    {
        $t = function (string $name) use ($basePrefix): string {
            return self::table($basePrefix, $name);
        };
        return array(
            "CREATE TABLE {$t('connections')} (
id varchar(64) NOT NULL,
label varchar(191) NOT NULL DEFAULT '',
scope varchar(10) NOT NULL,
public_key varchar(64) NOT NULL,
device_name varchar(191) NOT NULL DEFAULT '',
created_at bigint(20) unsigned NOT NULL,
expires_at bigint(20) unsigned NULL,
revoked_at bigint(20) unsigned NULL,
last_seen_at bigint(20) unsigned NULL,
last_ip varchar(64) NOT NULL DEFAULT '',
created_by bigint(20) unsigned NOT NULL DEFAULT 0,
PRIMARY KEY  (id)
) $collate;",
            "CREATE TABLE {$t('pairings')} (
id varchar(64) NOT NULL,
secret varchar(64) NULL,
scope varchar(10) NOT NULL,
label varchar(191) NOT NULL DEFAULT '',
connection_ttl bigint(20) unsigned NULL,
created_at bigint(20) unsigned NOT NULL,
expires_at bigint(20) unsigned NOT NULL,
attempts int(11) unsigned NOT NULL DEFAULT 0,
burned tinyint(1) NOT NULL DEFAULT 0,
used_at bigint(20) unsigned NULL,
created_by bigint(20) unsigned NOT NULL DEFAULT 0,
PRIMARY KEY  (id),
KEY expires_at (expires_at)
) $collate;",
            "CREATE TABLE {$t('nonces')} (
nonce_hash char(64) NOT NULL,
expires_at bigint(20) unsigned NOT NULL,
PRIMARY KEY  (nonce_hash),
KEY expires_at (expires_at)
) $collate;",
            "CREATE TABLE {$t('audit')} (
id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
at bigint(20) unsigned NOT NULL,
event varchar(32) NOT NULL,
connection_id varchar(64) NULL,
connection_label varchar(191) NULL,
ip varchar(64) NOT NULL DEFAULT '',
detail text NOT NULL,
noise tinyint(1) NOT NULL DEFAULT 0,
PRIMARY KEY  (id),
KEY at (at),
KEY noise (noise,id)
) $collate;",
            "CREATE TABLE {$t('deploys')} (
id varchar(64) NOT NULL,
connection_id varchar(64) NOT NULL,
connection_label varchar(191) NOT NULL DEFAULT '',
label varchar(191) NOT NULL DEFAULT '',
state varchar(16) NOT NULL,
reason varchar(16) NULL,
started_at bigint(20) unsigned NOT NULL,
updated_at bigint(20) unsigned NOT NULL,
finished_at bigint(20) unsigned NULL,
deadline bigint(20) unsigned NULL,
puts int(11) unsigned NOT NULL DEFAULT 0,
deletes int(11) unsigned NOT NULL DEFAULT 0,
rev int(11) unsigned NOT NULL DEFAULT 0,
started_us bigint(20) unsigned NOT NULL DEFAULT 0,
data longtext NOT NULL,
PRIMARY KEY  (id),
KEY state (state),
KEY started_at (started_at)
) $collate;",
            "CREATE TABLE {$t('hash_cache')} (
path_hash char(64) NOT NULL,
size bigint(20) unsigned NOT NULL,
mtime bigint(20) NOT NULL,
sha256 char(64) NOT NULL,
checked_at bigint(20) unsigned NOT NULL,
PRIMARY KEY  (path_hash),
KEY checked_at (checked_at)
) $collate;",
            "CREATE TABLE {$t('kv')} (
k varchar(191) NOT NULL,
v longtext NOT NULL,
expires_at bigint(20) unsigned NULL,
PRIMARY KEY  (k),
KEY expires_at (expires_at)
) $collate;",
        );
    }
}
