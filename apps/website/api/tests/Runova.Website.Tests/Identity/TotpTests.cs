using System.Text;
using Runova.Website.Core.Identity;

namespace Runova.Website.Tests.Identity;

public class TotpTests
{
    // RFC 6238 appendix B, SHA-1. The vectors are 8 digits; a 6 digit code is their last 6.
    private static readonly byte[] _rfcKey = Encoding.ASCII.GetBytes("12345678901234567890");

    [Theory]
    [InlineData(59, "287082")]
    [InlineData(1111111109, "081804")]
    [InlineData(1111111111, "050471")]
    [InlineData(1234567890, "005924")]
    [InlineData(2000000000, "279037")]
    [InlineData(20000000000, "353130")]
    public void Code_matches_the_rfc_test_vectors(long unixSeconds, string expected)
    {
        var step = Totp.TimeStep(DateTimeOffset.FromUnixTimeSeconds(unixSeconds));

        Assert.Equal(expected, Totp.Code(_rfcKey, step));
    }

    [Fact]
    public void A_time_step_is_30_seconds()
    {
        Assert.Equal(1, Totp.TimeStep(DateTimeOffset.FromUnixTimeSeconds(30)));
        Assert.Equal(1, Totp.TimeStep(DateTimeOffset.FromUnixTimeSeconds(59)));
        Assert.Equal(2, Totp.TimeStep(DateTimeOffset.FromUnixTimeSeconds(60)));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1)]
    public void FindStep_accepts_one_step_of_drift(int drift)
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1234567890);
        var step = Totp.TimeStep(now) + drift;

        Assert.Equal(step, Totp.FindStep(_rfcKey, Totp.Code(_rfcKey, step), now));
    }

    [Theory]
    [InlineData(-2)]
    [InlineData(2)]
    public void FindStep_refuses_a_code_further_off(int drift)
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1234567890);

        Assert.Null(Totp.FindStep(_rfcKey, Totp.Code(_rfcKey, Totp.TimeStep(now) + drift), now));
    }

    [Theory]
    [InlineData("")]
    [InlineData("12345")]
    [InlineData("1234567")]
    [InlineData("abcdef")]
    public void FindStep_refuses_what_is_not_six_digits(string code)
    {
        Assert.Null(Totp.FindStep(_rfcKey, code, DateTimeOffset.FromUnixTimeSeconds(59)));
    }

    [Fact]
    public void FindStep_ignores_spaces_and_dashes()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(59);

        Assert.Equal(1, Totp.FindStep(_rfcKey, "287 082", now));
        Assert.Equal(1, Totp.FindStep(_rfcKey, "287-082", now));
    }
}
