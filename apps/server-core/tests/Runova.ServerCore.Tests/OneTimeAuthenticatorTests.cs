using System.Text;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The codes an authenticator app shows, computed the way RFC 6238 defines them, from a key typed
/// or scanned the way the apps present it.
/// </summary>
public sealed class OneTimeAuthenticatorTests
{
    /// <summary>The SHA-1 secret of RFC 6238, appendix B.</summary>
    private static readonly byte[] _rfcSecret = Encoding.ASCII.GetBytes("12345678901234567890");

    [Theory]
    [InlineData(59, "287082")]
    [InlineData(1111111109, "081804")]
    [InlineData(1111111111, "050471")]
    [InlineData(1234567890, "005924")]
    [InlineData(2000000000, "279037")]
    [InlineData(20000000000, "353130")]
    public void Codes_match_the_rfc_6238_test_vectors(long unixSeconds, string code)
    {
        Assert.Equal(code, Totp.Code(_rfcSecret, unixSeconds / Totp.StepSeconds));
    }

    [Theory]
    [InlineData("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")]
    [InlineData("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")]
    [InlineData("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ====")]
    public void A_key_reads_the_way_authenticator_apps_show_it(string key)
    {
        Assert.Equal(_rfcSecret, Totp.DecodeKey(key));
    }

    [Theory]
    [InlineData("GEZDGNBV1")]
    [InlineData("not a key!")]
    [InlineData("")]
    public void Anything_that_is_not_base32_is_no_key(string key)
    {
        Assert.Null(Totp.DecodeKey(key));
    }
}
