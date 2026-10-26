<?php
/**
 * Runs one request through authentication and its route, and turns the outcome into a signed
 * response envelope. The same for every transport (REST, admin-ajax, and later rescue.php).
 *
 * Authentication order for connection routes:
 *  1. rate limiter (a locked-out IP gets an unsigned 429 and nothing else);
 *  2. am_auth parses;
 *  3. the connection exists and is not revoked or expired;
 *  4. the timestamp is within 300 seconds (staleTimestamp carries serverTime);
 *  5. the bundle is within the size cap;
 *  6. the bundle's hash goes into the canonical text and the Ed25519 signature is checked;
 *  7. the nonce is recorded, after the signature checked out, so a forged request burns nothing;
 *  8. scope (read-only keys get readOnly on write routes);
 *  9. kill switches: RUNOVA_CONNECTOR_DISABLED; for writes also RUNOVA_CONNECTOR_READ_ONLY,
 *     DISALLOW_FILE_MODS and a filesystem method other than direct (each switch also under the
 *     name it had before the rename);
 * 10. only then is the bundle gunzipped (with a limit) and the frame read.
 *
 * Every reply, errors included, is signed over the route, the request's nonce and the connection
 * id the request named ('-' for none), so /hello and /pair replies are signed with '-'. The reply
 * uses the signing prefix the request verified with, or the endpoint's when it never verified.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

use Runova\Connector\Audit\AuditLog;
use Runova\Connector\Auth\Canonical;
use Runova\Connector\Auth\Pairing;
use Runova\Connector\Auth\RateLimiter;
use Runova\Connector\Crypto\Base64Url;
use Runova\Connector\Crypto\Crypto;
use Runova\Connector\Crypto\SiteKeys;
use Runova\Connector\Env\Environment;
use Runova\Connector\Info\Limits;
use Runova\Connector\Protocol;
use Runova\Connector\Routes\Handler;
use Runova\Connector\Routes\NotYetHandler;
use Runova\Connector\Routes\RequestContext;
use Runova\Connector\Storage\Storage;

final class Dispatcher
{
    /** Features a client can count on from this build. */
    const CAPABILITIES = array('pair', 'read', 'audit', 'revoke', 'deploy', 'update', 'updateDownload', 'rescue', 'migrate');

    /** @var Storage */
    private $storage;

    /** @var Environment */
    private $env;

    /** @var SiteKeys */
    private $keys;

    /** @var RateLimiter */
    private $limiter;

    /** @var AuditLog */
    private $audit;

    /** @var array<string, Handler> */
    private $handlers;

    /** @var callable|null receives unexpected errors, for the PHP error log */
    private $logger;

    /** @var string the signing prefix of the request being handled, which its reply is signed with */
    private $prefix = Protocol::PREFIX;

    /**
     * @param array<string, Handler> $handlers route => handler
     */
    public function __construct(Storage $storage, Environment $env, SiteKeys $keys, array $handlers, ?callable $logger = null)
    {
        $this->storage = $storage;
        $this->env = $env;
        $this->keys = $keys;
        $this->limiter = new RateLimiter($storage);
        $this->audit = new AuditLog($storage);
        $this->handlers = $handlers;
        $this->logger = $logger;
    }

    public function handle(IncomingRequest $request): OutgoingResponse
    {
        $now = $this->env->now();
        $route = Protocol::isRoute($request->route) ? $request->route : null;
        $nonce = '-';
        $connectionId = null;
        $connection = null;
        $this->prefix = $request->prefix;
        try {
            $locked = $this->limiter->lockedFor($request->ip, $now);
            if ($locked > 0 && !$this->namesLiveConnection($route, $request->auth, $now)) {
                return $this->unsignedRateLimited($route, $locked);
            }
            if ($now % 16 === 0) {
                $this->storage->purgeExpired($now);
            }
            if ($route === null) {
                throw ApiError::badRequest('That is not a route this plugin answers.');
            }
            $auth = $request->auth === null ? null : Canonical::parseAuth($request->auth);
            if ($auth !== null) {
                // Known before anything is trusted, so even a refusal can name the request it answers.
                $nonce = $auth['nonce'];
                $connectionId = $auth['connectionId'];
            }
            if ($request->bodyTooLarge) {
                throw new ApiError('tooLarge', 'The request is larger than this site accepts.', array(
                    'maxRequestBytes' => Limits::maxRequestBytes($this->env->iniGet('post_max_size'), $this->env->iniGet('upload_max_filesize')),
                ));
            }
            if ($auth === null) {
                throw ApiError::auth('unauthorized', 'The request is not signed the way this plugin expects.');
            }

            if ($route === Protocol::ROUTES['hello']) {
                return $this->respond($route, $nonce, $connectionId, 200, array('ok' => true, 'data' => $this->hello($now)));
            }
            if ($route === Protocol::ROUTES['pair']) {
                $data = (new Pairing($this->storage, $this->env, $this->audit))->pair($auth, $request->bundle, $request->ip, $this->prefix);
                return $this->respond($route, $nonce, $connectionId, 200, array('ok' => true, 'data' => $data));
            }

            $connection = $this->authenticate($route, $auth, $request, $now, $connection);
            $frame = BundleReader::open(
                $request->bundle,
                $route,
                Protocol::BATCH_MAX_BYTES,
                Limits::maxDecodedBytes($this->env->iniGet('memory_limit'), $this->env->memoryUsage())
            );
            if ($connection['last_seen_at'] === null || $now - $connection['last_seen_at'] >= 60 || $connection['last_ip'] !== $request->ip) {
                $this->storage->touchConnection($connection['id'], $now, $request->ip);
            }
            $handler = isset($this->handlers[$route]) ? $this->handlers[$route] : new NotYetHandler();
            $result = $handler->handle(new RequestContext($route, $frame, $connection, $request->ip, $now));
            return $this->respond($route, $nonce, $connectionId, 200, array('ok' => true, 'data' => $result->data), $result->blobs);
        } catch (ApiError $error) {
            if ($error->authFailure) {
                $this->recordFailure($request->ip, $now, $route, $error, $connection);
            }
            return $this->respondError($route, $nonce, $connectionId, $error);
        } catch (\Throwable $error) {
            if ($this->logger !== null) {
                call_user_func($this->logger, $error);
            }
            return $this->respondError($route, $nonce, $connectionId, new ApiError('internal', 'Something went wrong on the site. Its PHP error log has the details.'));
        }
    }

    /**
     * A locked-out address may still be shared with the paired app (an office NAT, say). A signed
     * request naming a live connection goes on to full verification; a bad signature then counts
     * as one more failure. Unsigned and unknown requests stay locked out.
     */
    private function namesLiveConnection(?string $route, ?string $authField, int $now): bool
    {
        if ($route === null || $authField === null || in_array($route, array(Protocol::ROUTES['hello'], Protocol::ROUTES['pair']), true)) {
            return false;
        }
        $auth = Canonical::parseAuth($authField);
        if ($auth === null || $auth['connectionId'] === null || $auth['signature'] === null) {
            return false;
        }
        $connection = $this->storage->getConnection($auth['connectionId']);
        return $connection !== null
            && $connection['revoked_at'] === null
            && ($connection['expires_at'] === null || $connection['expires_at'] > $now);
    }

    /**
     * @param array{connectionId: ?string, timestamp: int, nonce: string, signature: ?string} $auth
     * @param array<string, mixed>|null $connection set as soon as the connection is found, so a
     *        refusal after that point is audited against it
     * @return array<string, mixed> the connection row
     */
    private function authenticate(string $route, array $auth, IncomingRequest $request, int $now, ?array &$connection): array
    {
        if ($auth['connectionId'] === null || $auth['signature'] === null) {
            throw ApiError::auth('unauthorized', 'This route needs a signed request from a paired app.');
        }
        $connection = $this->storage->getConnection($auth['connectionId']);
        if ($connection === null) {
            throw ApiError::auth('unknownConnection', 'This site does not know that connection. Connect again with a new key.');
        }
        if ($connection['revoked_at'] !== null) {
            throw ApiError::auth('revoked', 'This connection was revoked on the site.');
        }
        if ($connection['expires_at'] !== null && $connection['expires_at'] <= $now) {
            throw ApiError::auth('revoked', 'This connection has expired. Connect again with a new key.', array('expired' => true));
        }
        if (abs($now - $auth['timestamp']) > Protocol::TIMESTAMP_WINDOW_SECONDS) {
            throw ApiError::auth('staleTimestamp', 'The request time is too far from the site clock.', array('serverTime' => $now));
        }
        $bundle = $request->bundle;
        if ($bundle === null) {
            throw ApiError::badRequest('The request has no bundle.');
        }
        if ($bundle->size() > Protocol::BATCH_MAX_BYTES) {
            throw new ApiError('tooLarge', 'The request is larger than this site accepts.', array('maxBytes' => Protocol::BATCH_MAX_BYTES));
        }
        $signature = Base64Url::decode((string) $auth['signature']);
        $publicKey = Base64Url::decode($connection['public_key']);
        $verified = null;
        if ($signature !== null && $publicKey !== null) {
            // The endpoint's prefix first, then the other one: a 1.63 desktop signs with the old
            // prefix, and it may be calling the Runova endpoints a site reported to it.
            foreach (array($this->prefix, Protocol::otherPrefix($this->prefix)) as $prefix) {
                $text = Canonical::request($route, $auth['timestamp'], $auth['nonce'], $auth['connectionId'], $bundle->sha256(), $prefix);
                if (Crypto::verify($signature, $text, $publicKey)) {
                    $verified = $prefix;
                    break;
                }
            }
        }
        if ($verified === null) {
            throw ApiError::auth('badSignature', 'The request signature does not match this connection.');
        }
        $this->prefix = $verified;
        $nonceKey = hash('sha256', $connection['id'] . "\n" . $auth['nonce']);
        if (!$this->storage->insertNonce($nonceKey, $now + 2 * Protocol::TIMESTAMP_WINDOW_SECONDS + 60)) {
            throw ApiError::auth('replayed', 'This request was already used.');
        }
        $write = Protocol::isWriteRoute($route);
        if ($write && $connection['scope'] !== 'write') {
            throw new ApiError('readOnly', 'This connection can only read. Create a write key in wp-admin to deploy.');
        }
        if ($this->env->constantOn('RUNOVA_CONNECTOR_DISABLED')) {
            throw new ApiError('disabled', 'Runova Connector is switched off in wp-config.php.');
        }
        if ($write) {
            if ($this->env->constantOn('RUNOVA_CONNECTOR_READ_ONLY')) {
                throw new ApiError('readOnly', 'Runova Connector is set to read-only in wp-config.php.', array('byConstant' => true));
            }
            if (!$this->env->fileModsAllowed()) {
                throw new ApiError('fileModsDisabled', 'File changes are switched off on this site (DISALLOW_FILE_MODS).');
            }
            $method = $this->env->filesystemMethod();
            if ($method !== 'direct') {
                throw new ApiError('notDirect', 'WordPress cannot write files directly on this site, so deploys are off.', array('method' => $method));
            }
        }
        return $connection;
    }

    /**
     * @return array<string, mixed> the WpHelloResponse
     */
    private function hello(int $now): array
    {
        if ($this->env->constantOn('RUNOVA_CONNECTOR_DISABLED')) {
            throw new ApiError('disabled', 'Runova Connector is switched off in wp-config.php.');
        }
        return array(
            'protocol' => Protocol::VERSION,
            'pluginVersion' => $this->env->pluginVersion(),
            'sitePublicKey' => $this->keys->publicKeyBase64(),
            'serverTime' => $now,
            'capabilities' => self::CAPABILITIES,
            'rescueUrl' => $this->env->rescueUrl(),
            'multisite' => $this->env->isMultisite(),
            'siteName' => $this->env->siteName(),
            'layout' => $this->env->layout(),
            // Where this copy answers now, so an app that saved older addresses can repair them.
            'endpoints' => array('restUrl' => $this->env->restUrl(), 'ajaxUrl' => $this->env->ajaxUrl()),
        );
    }

    /**
     * @param array<string, mixed>|null $connection
     */
    private function recordFailure(string $ip, int $now, ?string $route, ApiError $error, ?array $connection): void
    {
        try {
            // Only refusals that name a real connection are worth a row; anonymous junk is only
            // counted by the rate limiter. (A pairing burned by wrong proofs logs its own row.)
            if ($connection !== null) {
                $this->audit->add('authFailed', $now, $ip, $error->errorCode . ' on ' . ($route === null ? 'an unknown route' : $route), $connection);
            }
            // One row per address per lockout: recordFailure() is true only when a lockout starts.
            if ($this->limiter->recordFailure($ip, $now)) {
                $this->audit->add('rateLimited', $now, $ip, 'Too many failed requests; this address is locked out for 15 minutes.');
            }
        } catch (\Throwable $ignored) {
            // Bookkeeping must never turn a clean refusal into an internal error.
            unset($ignored);
        }
    }

    private function unsignedRateLimited(?string $route, int $seconds): OutgoingResponse
    {
        $body = array(
            'ok' => false,
            'error' => array(
                'code' => 'rateLimited',
                'message' => 'Too many failed requests from this address. Try again later.',
                'details' => array('retryAfter' => $seconds),
            ),
        );
        $payload = Gzip::encode(Frame::encode($route === null ? Protocol::ROUTES['hello'] : $route, $body));
        return new OutgoingResponse(429, Envelope::encode($this->env->now(), 429, '', $payload), array('Retry-After' => (string) $seconds));
    }

    private function respondError(?string $route, string $nonce, ?string $connectionId, ApiError $error): OutgoingResponse
    {
        $body = array('code' => $error->errorCode, 'message' => $error->getMessage());
        if (count($error->details) > 0) {
            $body['details'] = $error->details;
        }
        $headers = array();
        if ($error->errorCode === 'rateLimited' && isset($error->details['retryAfter'])) {
            $headers['Retry-After'] = (string) $error->details['retryAfter'];
        }
        return $this->respond($route, $nonce, $connectionId, $error->status, array('ok' => false, 'error' => $body), array(), $headers);
    }

    /**
     * @param array<string, mixed> $body
     * @param string[] $blobs
     * @param array<string, string> $headers
     */
    private function respond(?string $route, string $nonce, ?string $connectionId, int $status, array $body, array $blobs = array(), array $headers = array()): OutgoingResponse
    {
        $frameRoute = $route === null ? Protocol::ROUTES['hello'] : $route;
        try {
            $frame = Frame::encode($frameRoute, $body, $blobs);
        } catch (\InvalidArgumentException $error) {
            $status = 500;
            $frame = Frame::encode($frameRoute, array('ok' => false, 'error' => array('code' => 'internal', 'message' => 'The reply could not be written.')));
            $blobs = array();
        }
        $total = 0;
        foreach ($blobs as $blob) {
            $total += strlen($blob);
        }
        // Big replies are mostly file contents, often already compressed: favour speed.
        $payload = Gzip::encode($frame, $total > 1048576 ? 1 : 6);
        $timestamp = $this->env->now();
        try {
            $signature = $this->keys->sign(Canonical::response($route === null ? '-' : $route, $nonce, $connectionId, $timestamp, $status, hash('sha256', $payload), $this->prefix));
        } catch (\Throwable $error) {
            if ($this->logger !== null) {
                call_user_func($this->logger, $error);
            }
            $signature = '';
        }
        return new OutgoingResponse($status, Envelope::encode($timestamp, $status, $signature, $payload), $headers);
    }
}
