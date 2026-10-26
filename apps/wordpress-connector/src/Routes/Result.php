<?php
/**
 * What a handler returns: the `data` of an ok response, and blobs to append to the frame.
 *
 * @package Runova\Connector
 */

namespace Runova\Connector\Routes;

final class Result
{
    /** @var mixed */
    public $data;

    /** @var string[] */
    public $blobs;

    /**
     * @param mixed $data
     * @param string[] $blobs
     */
    public function __construct($data, array $blobs = array())
    {
        $this->data = $data;
        $this->blobs = $blobs;
    }
}
