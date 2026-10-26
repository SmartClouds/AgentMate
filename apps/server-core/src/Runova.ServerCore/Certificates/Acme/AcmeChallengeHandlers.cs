namespace Runova.ServerCore.Certificates.Acme;

/// <summary>
/// Serves HTTP-01 answers: for as long as a challenge is being validated, a plain HTTP GET of
/// <c>http://{domain}/.well-known/acme-challenge/{token}</c> must return the key authorization
/// (RFC 8555 section 8.3). The nginx webroot implements this (E10 and E11), with SELinux labels on
/// RHEL.
/// </summary>
internal interface IHttp01ChallengePublisher
{
    /// <param name="domain">The name being validated, so the answer lands in that site's webroot.</param>
    /// <param name="token">Base64url, safe to use as a file name.</param>
    /// <param name="keyAuthorization">What the file must contain.</param>
    Task PublishAsync(string domain, string token, string keyAuthorization, CancellationToken cancellationToken);

    /// <summary>Removes the answer again. Called after validation, whether it passed or not.</summary>
    Task RemoveAsync(string domain, string token, CancellationToken cancellationToken);
}

/// <summary>
/// Creates and removes the TXT records of DNS-01 (RFC 8555 section 8.4), used for wildcards and
/// for sites that cannot answer on port 80. The Cloudflare implementation comes with E14.
/// </summary>
/// <remarks>
/// A name and its wildcard (example.com and *.example.com) share one record name with two
/// values, so publishing a value must add to the record, not replace it.
/// </remarks>
internal interface IDns01ChallengeHook
{
    /// <summary>
    /// Adds the value and returns once the CA can see it, which for a real DNS provider means
    /// waiting for its authoritative servers to serve the record.
    /// </summary>
    /// <param name="domain">The name being validated, without a wildcard label.</param>
    /// <param name="recordName">"_acme-challenge." plus the domain.</param>
    /// <param name="value">The TXT value: base64url(SHA-256(key authorization)).</param>
    Task PublishAsync(string domain, string recordName, string value, CancellationToken cancellationToken);

    /// <summary>Removes this value (and only this one) again.</summary>
    Task RemoveAsync(string domain, string recordName, string value, CancellationToken cancellationToken);
}

/// <summary>
/// A DNS-01 hook that can only answer for some names (the Cloudflare one needs a token for the
/// zone). Issuance asks first, so a wildcard without a token is refused with a reason at once
/// instead of failing halfway through an order.
/// </summary>
internal interface IDns01Coverage
{
    Task<bool> CoversAsync(string domain, CancellationToken cancellationToken);
}
