<?php
/**
 * The wire contract, mirrored from packages/core/src/deploy/wordpress/protocol.ts. The TypeScript
 * side is the source of truth; the shared vectors keep the two in step.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector;

final class Protocol
{
    const VERSION = 1;
    const PREFIX = 'runova-wp/v1';
    /** What 1.63 desktops sign with. Requests are checked against both; a reply uses the one that matched. */
    const LEGACY_PREFIX = Legacy::PROTOCOL_PREFIX;
    const AUTH_FIELD = 'am_auth';
    const BUNDLE_FIELD = 'bundle';
    const REST_NAMESPACE = 'runova/v1';
    const AJAX_ACTION = 'runova_connector';
    /** Every namespace and ajax action served: the Runova ones, then the ones 1.63 desktops saved. */
    const REST_NAMESPACES = array(self::REST_NAMESPACE, Legacy::REST_NAMESPACE);
    const AJAX_ACTIONS = array(self::AJAX_ACTION, Legacy::AJAX_ACTION);

    const TIMESTAMP_WINDOW_SECONDS = 300;
    const PAIRING_TTL_SECONDS = 900;
    const PAIRING_MAX_ATTEMPTS = 5;

    const MAX_FRAME_HEADER_BYTES = 1048576;
    const MAX_FRAME_BLOBS = 1000;
    const MAX_FILE_BYTES = 67108864;
    const MAX_FILES_PER_ITEM = 20000;
    const MAX_PATH_BYTES = 400;
    const MAX_SEGMENT_BYTES = 200;
    const BATCH_MIN_BYTES = 65536;
    const BATCH_MAX_BYTES = 16777216;

    /** Bundles for /hello and /pair are read before anyone is known, so they stay small. */
    const MAX_UNAUTHENTICATED_BUNDLE_BYTES = 65536;

    /** Every JSON this plugin writes: no escaped slashes or Unicode, bad UTF-8 replaced. */
    const JSON_FLAGS = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE;

    const ROUTES = array(
        'hello' => '/hello',
        'pair' => '/pair',
        'siteInfo' => '/site/info',
        'itemsList' => '/items/list',
        'itemsManifest' => '/items/manifest',
        'filesRead' => '/files/read',
        'deployBegin' => '/deploy/begin',
        'deployUpload' => '/deploy/upload',
        'deployCommit' => '/deploy/commit',
        'deployVerify' => '/deploy/verify',
        'deployFinalize' => '/deploy/finalize',
        'deployRollback' => '/deploy/rollback',
        'deployAbort' => '/deploy/abort',
        'deployHistory' => '/deploy/history',
        'auditList' => '/audit/list',
        'connectionRevoke' => '/connection/revoke',
        'connectorUpdate' => '/connector/update',
        'connectorMigrate' => '/connector/migrate',
        'rescueStatus' => '/rescue/status',
        'rescueRollback' => '/rescue/rollback',
    );

    /** Routes a read-only key may not call. */
    const WRITE_ROUTES = array(
        '/deploy/begin',
        '/deploy/upload',
        '/deploy/commit',
        '/deploy/verify',
        '/deploy/finalize',
        '/deploy/rollback',
        '/deploy/abort',
        '/connector/update',
        '/connector/migrate',
        '/rescue/rollback',
    );

    /** What a connector update may hold; mirrors WP_UPDATE_* in protocol.ts. */
    const UPDATE_MAX_FILES = 400;
    const UPDATE_MAX_FILE_BYTES = 2097152;
    const UPDATE_MAX_TOTAL_BYTES = 8388608;
    const UPDATE_FILE_PATTERN = '/\.(php|txt|md|css|js|json|xml|html)$/iD';

    /**
     * The only address a site fetches an update from itself: a plugin zip on a Runova GitHub
     * release, runova-connector.zip or the bridge package. The tag must be the version being
     * installed. Mirrors wpConnectorReleaseUrl(). The repository's old name still redirects to
     * it, and 1.63 sites only know that one, so both are taken.
     */
    const UPDATE_DOWNLOAD_URL = '#^https://github\.com/SmartClouds/(?:Runova|AgentMate)/releases/download/v([0-9A-Za-z.+-]{1,40})/(runova-connector|agentmate-connector)\.zip$#D'; // legacy-name
    /** The release zip is compressed text, well under the files it holds. */
    const UPDATE_DOWNLOAD_MAX_BYTES = 9437184;
    const UPDATE_DOWNLOAD_TIMEOUT_SECONDS = 30;

    /**
     * The HTTP status sent with each error code. The contract does not fix these; clients should
     * read the code in the body. 413 is only ever sent when the request body itself is too big,
     * so a client can safely halve its batch on it.
     */
    const STATUS = array(
        'badRequest' => 400,
        'unauthorized' => 401,
        'badSignature' => 401,
        'staleTimestamp' => 401,
        'replayed' => 401,
        'unknownConnection' => 401,
        'revoked' => 401,
        'readOnly' => 403,
        'fileModsDisabled' => 403,
        'notDirect' => 403,
        'disabled' => 503,
        'pathRejected' => 422,
        'itemUnknown' => 404,
        'itemProtected' => 403,
        'deployUnknown' => 404,
        'conflict' => 409,
        'syntaxError' => 422,
        'busy' => 409,
        'invalidState' => 409,
        'tooLarge' => 413,
        'rateLimited' => 429,
        'pairingInvalid' => 401,
        'pairingExpired' => 410,
        'protocolMismatch' => 400,
        'updateRefused' => 422,
        'internal' => 500,
    );

    /**
     * @param mixed $value
     */
    public static function isRoute($value): bool
    {
        return is_string($value) && in_array($value, self::ROUTES, true);
    }

    /**
     * The release tag and the zip's name (its plugin folder) in a download address, or null for
     * any other address.
     *
     * @return array{tag: string, folder: string}|null
     */
    public static function downloadTag(string $url): ?array
    {
        if (preg_match(self::UPDATE_DOWNLOAD_URL, $url, $match) !== 1) {
            return null;
        }
        return array('tag' => $match[1], 'folder' => $match[2]);
    }

    /** The other signing prefix, for a request that did not verify with the first. */
    public static function otherPrefix(string $prefix): string
    {
        return $prefix === self::PREFIX ? self::LEGACY_PREFIX : self::PREFIX;
    }

    public static function isWriteRoute(string $route): bool
    {
        return in_array($route, self::WRITE_ROUTES, true);
    }

    public static function statusFor(string $code): int
    {
        return isset(self::STATUS[$code]) ? self::STATUS[$code] : 500;
    }
}
