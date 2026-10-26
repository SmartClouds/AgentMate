<?php
/**
 * Opens a bundle once it may be trusted: size first, then gunzip with a hard limit, then the frame,
 * which must be for the route the URL named.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Http;

final class BundleReader
{
    public static function open(Bundle $bundle, string $route, int $maxBytes, int $maxDecodedBytes): Frame
    {
        if ($bundle->size() > $maxBytes) {
            throw new ApiError('tooLarge', 'The request is larger than this site accepts.', array('maxBytes' => $maxBytes));
        }
        $gzip = $bundle->read($maxBytes);
        if ($gzip === null) {
            throw ApiError::badRequest('The bundle could not be read.');
        }
        $claimed = Gzip::claimedSize($gzip);
        if ($claimed !== null && $claimed > $maxDecodedBytes) {
            throw new ApiError('tooLarge', 'The bundle unpacks to more than this site accepts.', array('maxBytes' => $maxDecodedBytes));
        }
        $plain = Gzip::decode($gzip, $maxDecodedBytes);
        if ($plain === null) {
            throw ApiError::badRequest('The bundle is not valid gzip, or it unpacks to too much.');
        }
        $frame = Frame::decode($plain);
        if ($frame === null) {
            throw ApiError::badRequest('The bundle does not hold a valid frame.');
        }
        if ($frame->route !== $route) {
            throw ApiError::badRequest('The bundle was made for a different route.');
        }
        return $frame;
    }
}
