using Runova.ServerCore.Contracts;
using Runova.ServerCore.Security;

namespace Runova.ServerCore.Tests;

/// <summary>
/// The text a device signs. The desktop builds the same string (see its deviceKey tests, which pin
/// this very vector), so the two sides can only drift apart by breaking a test.
/// </summary>
public sealed class AuthMessageTests
{
    [Fact]
    public void A_renewal_names_every_field_that_decides_what_it_is_good_for()
    {
        var message = AuthMessage.For(
            AuthPurpose.Renew,
            Guid.Parse("0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e"),
            "bm9uY2U",
            Guid.Parse("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
            Guid.Parse("f0e1d2c3-b4a5-4968-8776-655443322110"));

        Assert.Equal(
            "runova-core/auth/v1\nrenew\n0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e\nbm9uY2U\na1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\nf0e1d2c3-b4a5-4968-8776-655443322110",
            message);
    }

    [Fact]
    public void A_login_has_no_session()
    {
        var message = AuthMessage.For(
            AuthPurpose.Login,
            Guid.Parse("0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e"),
            "n",
            Guid.Parse("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
            null);

        Assert.EndsWith("\nlogin\n0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e\nn\na1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\n-", message, StringComparison.Ordinal);
    }
}
