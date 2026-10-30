namespace Runova.Website.Data.ApiClients;

/// <summary>
/// A nonce a signed request came with. The unique index on key id and nonce is what refuses a
/// replay; the <c>signature-nonces-purge</c> job deletes the ones too old to be accepted anyway.
/// </summary>
public class SignatureNonce
{
    public long Id { get; set; }

    public string KeyId { get; set; } = "";

    public string Nonce { get; set; } = "";

    public DateTimeOffset SeenAt { get; set; }
}
